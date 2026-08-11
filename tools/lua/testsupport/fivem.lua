-- A faked FiveM runtime, just large enough to load the resource's server scripts.
--
-- The resource's decision logic is worth testing and the FiveM runtime is not available
-- outside a running server. Rather than restructure the resource around that, the handful
-- of natives it touches are stubbed here, and the tests drive them.

local M = {}

--- Everything the fake recorded, so tests can assert on what the resource did.
M.calls = {
    http = {},
    prints = {},
    clientEvents = {},
    dropped = {},
    timers = {},
}

--- Queued HTTP answers, consumed in order by Http.await.
M.httpResponses = {}

local function reset_calls()
    M.calls = { http = {}, prints = {}, clientEvents = {}, dropped = {}, timers = {} }
    M.httpResponses = {}
end

M.reset = reset_calls

--- Installs the fake into the global environment.
--- @param convars table values returned by GetConvar, keyed by name
function M.install(convars)
    convars = convars or {}
    reset_calls()

    _G.GetConvar = function(name, default)
        local value = convars[name]
        if value == nil then
            return default
        end
        return value
    end

    _G.GetConvarInt = function(name, default)
        local value = convars[name]
        if value == nil then
            return default
        end
        return tonumber(value) or default
    end

    _G.print = function(text)
        M.calls.prints[#M.calls.prints + 1] = tostring(text)
    end

    _G.AddEventHandler = function() end
    _G.RegisterNetEvent = function() end
    _G.CancelEvent = function() end
    _G.GetCurrentResourceName = function() return 'fiveprotect' end

    _G.TriggerClientEvent = function(name, target, payload)
        M.calls.clientEvents[#M.calls.clientEvents + 1] =
            { name = name, target = target, payload = payload }
    end

    _G.DropPlayer = function(source, reason)
        M.calls.dropped[#M.calls.dropped + 1] = { source = source, reason = reason }
    end

    _G.SetTimeout = function(delay, callback)
        -- Timers are recorded, never fired. A test that wants a timeout queues one as an
        -- HTTP answer instead, which keeps the suite free of real waiting.
        M.calls.timers[#M.calls.timers + 1] = { delay = delay, callback = callback }
    end

    _G.Citizen = {
        Wait = function() end,
        CreateThread = function(body) body() end,
        Await = function(value) return value end,
    }

    _G.promise = {
        new = function()
            return {
                resolve = function(self, value) self.value = value end,
            }
        end,
    }

    _G.json = require('testsupport.json')

    _G.GetPlayerEndpoint = function() return convars.__endpoint or '203.0.113.42:30120' end
    _G.GetNumPlayerIdentifiers = function() return #(convars.__identifiers or {}) end
    _G.GetPlayerIdentifier = function(_source, index)
        return (convars.__identifiers or {})[index + 1]
    end
end

--- Queues the next answer Http.await will return.
function M.queueHttp(response)
    M.httpResponses[#M.httpResponses + 1] = response
end

--- Replaces Http with a fake that serves the queued answers.
---
--- The real Http talks to PerformHttpRequest, which does not exist here. Faking at this
--- seam rather than at the native keeps the tests about gate behaviour instead of about
--- callback plumbing.
function M.installHttp()
    _G.Http = {
        await = function(method, path, body, timeout)
            M.calls.http[#M.calls.http + 1] =
                { method = method, path = path, body = body, timeout = timeout }
            local response = table.remove(M.httpResponses, 1)
            if response == nil then
                return { ok = false, reason = 'no queued response for ' .. method .. ' ' .. path }
            end
            return response
        end,
        request = function() error('Http.request is not used by the tests', 2) end,
    }
end

--- Loads a resource file into the current environment.
function M.load(paths, relative)
    local chunk, err = loadfile(paths.repo_root() .. relative)
    if not chunk then
        error('cannot load ' .. relative .. ': ' .. tostring(err), 0)
    end
    return chunk()
end

return M
