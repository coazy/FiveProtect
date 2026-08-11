--- Configuration for the FiveProtect resource.
---
--- Credentials come from convars, never from this file. A server key committed to a
--- repository is a server key that leaks.
---
---   set fiveprotect_server_id  "8f14e45f-ceea-467a-9ba8-a53d9d0e0a3c"
---   set fiveprotect_server_key "…"          -- from `provision`, shown once
---   set fiveprotect_backend    "https://api.fiveprotect.dev"

Config = {}

--- Base URL of the backend.
Config.backendUrl = GetConvar('fiveprotect_backend', 'https://api.fiveprotect.dev')

--- Identifies this game server within the tenant.
Config.serverId = GetConvar('fiveprotect_server_id', '')

--- Bearer credential. Read once at start-up and never logged.
Config.serverKey = GetConvar('fiveprotect_server_key', '')

--- What happens when the backend cannot be reached.
---
--- The backend's own setting is authoritative and lives on the tenant (ADR 0005). This is
--- the fallback for the case where the backend is unreachable and therefore cannot tell us
--- what it would have wanted. `true` matches the product default.
Config.failOpenWhenBackendUnreachable = GetConvarInt('fiveprotect_fail_open', 1) == 1

--- Seconds to wait for the verdict before giving up. Must stay above the backend's long
--- poll window, or the resource abandons a poll the backend is about to answer.
Config.verdictTimeoutSeconds = GetConvarInt('fiveprotect_verdict_timeout', 25)

--- How often an in-game player's session is checked, in seconds.
Config.livenessIntervalSeconds = GetConvarInt('fiveprotect_liveness_interval', 30)

--- Print every gate decision to the server console. Useful while rolling out, noisy after.
Config.verbose = GetConvarInt('fiveprotect_verbose', 0) == 1

--- Fails fast at start-up rather than on the first connecting player.
--- @return boolean, string|nil
function Config.validate()
    if Config.serverId == '' then
        return false, 'fiveprotect_server_id is not set'
    end
    if Config.serverKey == '' then
        return false, 'fiveprotect_server_key is not set'
    end
    if not string.match(Config.backendUrl, '^https?://') then
        return false, 'fiveprotect_backend must be an http or https URL'
    end
    if string.match(Config.backendUrl, '^http://') and not string.match(Config.backendUrl, '^http://127%.0%.0%.1')
        and not string.match(Config.backendUrl, '^http://localhost') then
        -- The server key travels on this connection. Plain HTTP to anywhere but the local
        -- machine hands it to whoever is on the path.
        return false, 'fiveprotect_backend must use https outside of local development'
    end
    return true
end
