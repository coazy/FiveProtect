--- Thin wrapper around PerformHttpRequest.
---
--- FiveM's HTTP call is callback based and has no timeout of its own. A deferred player
--- would otherwise sit on a spinner for ever if the backend accepted the connection and
--- then went quiet, so every request here carries a deadline.

Http = {}

local json = json

--- Requests in flight, keyed by an id we hand out. Used to ignore a late response whose
--- deadline already fired — otherwise a slow reply would resolve a promise twice.
local pending = {}
local nextRequestId = 0

--- Performs a JSON request and calls `callback(result)` exactly once.
---
--- `result` is `{ ok = true, status = number, body = table }` or
--- `{ ok = false, reason = string }`. Network failure and a refusal by the backend are
--- deliberately different shapes: the first means we learned nothing, the second means we
--- learned something.
---
--- @param method string
--- @param path string appended to the configured backend URL
--- @param body table|nil
--- @param timeoutSeconds number
--- @param callback fun(result: table)
function Http.request(method, path, body, timeoutSeconds, callback)
    nextRequestId = nextRequestId + 1
    local requestId = nextRequestId
    pending[requestId] = true

    local function finish(result)
        if not pending[requestId] then
            return
        end
        pending[requestId] = nil
        callback(result)
    end

    local headers = {
        ['Content-Type'] = 'application/json',
        ['Authorization'] = 'Bearer ' .. Config.serverKey,
        ['User-Agent'] = 'fiveprotect-resource/0.1.0',
    }

    PerformHttpRequest(Config.backendUrl .. path, function(status, responseText, _responseHeaders)
        if status == 0 then
            -- FiveM reports a transport failure as status 0. There is no response to read.
            finish({ ok = false, reason = 'network' })
            return
        end

        local decoded = nil
        if responseText and responseText ~= '' then
            local success, value = pcall(json.decode, responseText)
            if success then
                decoded = value
            end
        end

        if decoded == nil then
            finish({ ok = false, reason = 'malformed_response' })
            return
        end

        finish({ ok = true, status = status, body = decoded })
    end, method, body and json.encode(body) or '', headers)

    SetTimeout(math.floor(timeoutSeconds * 1000), function()
        finish({ ok = false, reason = 'timeout' })
    end)
end

--- Promise-style wrapper for use inside a coroutine.
--- @return table result
function Http.await(method, path, body, timeoutSeconds)
    local promise = promise.new()
    Http.request(method, path, body, timeoutSeconds, function(result)
        promise:resolve(result)
    end)
    return Citizen.Await(promise)
end
