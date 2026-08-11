--- Keeps track of players who are in game.
---
--- The companion beats to the backend; the resource asks the backend whether a player may
--- stay. Design document 5.5: a companion restart or a short network drop survives, a
--- deliberate exit does not.

Liveness = {}

--- sessionId per player source, for players the gate let in.
local sessions = {}

--- Sources already warned, so the warning is shown once per grace period rather than on
--- every poll.
local warned = {}

local WARNING_TEXT =
    'FiveProtect antwortet nicht mehr. Starte die Anwendung, sonst wirst du gleich vom Server getrennt.'

function Liveness.track(source, sessionId)
    sessions[source] = sessionId
    warned[source] = nil
end

function Liveness.forget(source)
    sessions[source] = nil
    warned[source] = nil
end

function Liveness.sessionOf(source)
    return sessions[source]
end

function Liveness.tracked()
    local list = {}
    for source, sessionId in pairs(sessions) do
        list[#list + 1] = { source = source, sessionId = sessionId }
    end
    return list
end

--- Decides what to do with one liveness answer.
---
--- Pure, so the boundary cases are unit tests instead of a stopwatch and a spare client.
--- @param response table LivenessResponse
--- @param alreadyWarned boolean
--- @return table action `{ kick = boolean, warn = boolean, reason = string|nil }`
function Liveness.decide(response, alreadyWarned)
    if response.shouldKick then
        return { kick = true, warn = false, reason = response.reason or 'heartbeat_lost' }
    end

    -- graceExpiresAt is only set while the heartbeat is overdue. That is exactly the window
    -- in which the player should see a warning rather than a disconnect.
    if response.graceExpiresAt ~= nil and not alreadyWarned then
        return { kick = false, warn = true }
    end

    return { kick = false, warn = false }
end

--- Polls the backend once for every tracked player.
function Liveness.poll()
    for _, entry in ipairs(Liveness.tracked()) do
        local response = Http.await('GET', '/v1/sessions/' .. entry.sessionId .. '/liveness', nil, 10)

        if response.ok and response.status == 200 then
            local valid = Protocol.validate.LivenessResponse(response.body)
            if valid then
                local action = Liveness.decide(response.body, warned[entry.source] == true)

                if action.warn then
                    warned[entry.source] = true
                    TriggerClientEvent('chat:addMessage', entry.source, {
                        color = { 255, 170, 0 },
                        args = { 'FiveProtect', WARNING_TEXT },
                    })
                elseif not action.kick then
                    warned[entry.source] = nil
                end

                if action.kick then
                    local text = FallbackKickText(action.reason)
                    DropPlayer(entry.source, text)
                    Liveness.forget(entry.source)
                end
            end
        end
        -- An unreachable backend does not remove anybody. ADR 0005: our outage is not the
        -- player's problem, and the server-authoritative detection keeps running.
    end
end

--- @param reason string
--- @return string
function FallbackKickText(reason)
    if reason == 'banned' then
        return 'Dieser Account ist auf diesem Server gesperrt.'
    end
    if reason == 'game_process_missing' then
        return 'FiveProtect hat FiveM nicht mehr gefunden. Starte beide auf demselben PC.'
    end
    if reason == 'companion_outdated' then
        return 'Deine FiveProtect-Version hat sich während der Sitzung geändert. Starte neu und verbinde dich erneut.'
    end
    return 'FiveProtect hat sich beendet. Starte die Anwendung und verbinde dich erneut.'
end
