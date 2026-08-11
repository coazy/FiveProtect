--- The connect gate.
---
--- Design document 5.1. The resource defers the player, asks the backend for a nonce, hands
--- it to the client, and then *pulls* the verdict. Nothing is pushed to the resource, so
--- there is no inbound path an attacker could feed (design document 5.2).

Gate = {}

local protocol = Protocol

--- Player-facing text for a denial the backend did not explain itself.
---
--- The backend supplies remediation text for everything it can; this is the fallback for
--- the cases that never reach it, chiefly "the companion is not running".
local FALLBACK_TEXT = {
    companion_missing = 'FiveProtect läuft nicht. Starte die Anwendung und verbinde dich danach erneut.',
    companion_timeout = 'FiveProtect hat nicht rechtzeitig geantwortet. Starte die Anwendung neu und versuche es noch einmal.',
    backend_unavailable = 'Der Anticheat-Dienst ist gerade nicht erreichbar. Bitte versuche es in ein paar Minuten erneut.',
    nonce_expired = 'Die Prüfung hat zu lange gedauert. Versuche es einfach noch einmal.',
    heartbeat_lost = 'FiveProtect hat sich beendet. Starte die Anwendung und verbinde dich erneut.',
}

local GENERIC_DENIAL = 'Die Systemprüfung wurde nicht bestanden. Starte FiveProtect und versuche es erneut.'

--- Turns a verdict into the sentence the player sees.
---
--- Prefers the backend's remediation text, which names a concrete cause and a concrete
--- step. A reason code alone tells a player nothing they can act on.
--- @param verdict table
--- @return string
function Gate.messageFor(verdict)
    if type(verdict.remediation) == 'string' and verdict.remediation ~= '' then
        return verdict.remediation
    end

    if type(verdict.reasons) == 'table' then
        for _, reason in ipairs(verdict.reasons) do
            local text = FALLBACK_TEXT[reason]
            if text then
                return text
            end
        end
    end

    return GENERIC_DENIAL
end

--- What the resource does when the backend cannot be reached.
---
--- ADR 0005: the product default is to let the player in, log it and alert the operator. An
--- outage that empties the customer's server costs more than a short window without
--- companion checks, and the server-authoritative detection keeps running either way.
--- @param failOpen boolean
--- @return table decision `{ allow = boolean, message = string|nil }`
function Gate.degradedDecision(failOpen)
    if failOpen then
        return { allow = true, degraded = true }
    end
    return { allow = false, degraded = true, message = FALLBACK_TEXT.backend_unavailable }
end

--- Requests a nonce for a connecting player.
--- @return table result
function Gate.requestNonce(player)
    local response = Http.await('POST', '/v1/sessions/nonce', {
        serverId = Config.serverId,
        player = player,
        protocolVersion = protocol.PROTOCOL_VERSION,
    }, 10)

    if not response.ok then
        return { ok = false, degraded = true, reason = response.reason }
    end

    if response.status ~= 201 then
        return { ok = false, degraded = false, reason = response.body and response.body.code or 'unknown' }
    end

    local valid, err = protocol.validate.NonceResponse(response.body)
    if not valid then
        -- A backend that answers with something the protocol does not describe is a bug on
        -- our side, not a reason to punish the player.
        return { ok = false, degraded = true, reason = 'protocol:' .. tostring(err) }
    end

    return { ok = true, nonce = response.body }
end

--- Pulls the verdict. The backend holds the request open until it has one or times out.
--- @return table result
function Gate.pollVerdict(nonce)
    local response = Http.await('POST', '/v1/sessions/verdict', { nonce = nonce },
        Config.verdictTimeoutSeconds)

    if not response.ok then
        return { ok = false, degraded = true, reason = response.reason }
    end

    if response.status ~= 200 then
        return { ok = false, degraded = false, reason = response.body and response.body.code or 'unknown' }
    end

    local valid, err = protocol.validate.Verdict(response.body)
    if not valid then
        return { ok = false, degraded = true, reason = 'protocol:' .. tostring(err) }
    end

    return { ok = true, verdict = response.body }
end

--- Collects the identifiers FiveM exposes for a connecting player.
---
--- Only the ones the protocol declares. Everything else a player has linked stays where it
--- is — the backend has no use for it, and data we do not collect cannot leak.
--- @param source number
--- @return table
function Gate.identifiersOf(source)
    local player = { license = '', ip = GetPlayerEndpoint(source) or '' }

    for index = 0, GetNumPlayerIdentifiers(source) - 1 do
        local identifier = GetPlayerIdentifier(source, index)
        if identifier then
            if string.sub(identifier, 1, 8) == 'license:' then
                player.license = identifier
            elseif string.sub(identifier, 1, 6) == 'steam:' then
                player.steam = identifier
            elseif string.sub(identifier, 1, 8) == 'discord:' then
                player.discord = identifier
            end
        end
    end

    -- GetPlayerEndpoint returns "address:port"; the port is noise for an IP comparison and
    -- would make every relay check fail.
    local address = string.match(player.ip, '^([^:]+):%d+$')
    if address then
        player.ip = address
    end

    return player
end
