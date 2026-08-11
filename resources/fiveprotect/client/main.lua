--- Client half of the connect gate.
---
--- The client's only job is to carry the nonce from the server to the companion on
--- 127.0.0.1 and to report whether anything answered. It never sees a verdict — the
--- resource pulls that from the backend — so there is nothing here worth tampering with
--- (design document 5.2).

local isRunning = false

RegisterNetEvent('fiveprotect:attest')
AddEventHandler('fiveprotect:attest', function(command)
    if isRunning then
        return
    end
    isRunning = true

    -- The NUI frame does the actual request: it is a CEF instance and can speak HTTP to
    -- 127.0.0.1, which Lua on the client cannot without a native extension — and injecting
    -- one into the FiveM process is out of scope by design (design document 3).
    SendNUIMessage({
        type = 'fiveprotect:attest',
        nonce = command.nonce,
        backendUrl = command.backendUrl,
        serverName = command.serverName,
        protocolVersion = command.protocolVersion,
    })
end)

--- Reported by the NUI frame once it has tried the port range.
---
--- Purely informational: the backend already knows whether an attestation arrived, and it
--- would be unwise to let the client's word decide anything (ADR 0004). It exists so the
--- deferral message can say "FiveProtect is not running" instead of leaving the player to wait
--- out the timeout.
RegisterNUICallback('fiveprotect:result', function(data, cb)
    isRunning = false
    TriggerServerEvent('fiveprotect:localResult', {
        reached = data and data.reached == true,
        port = data and data.port or nil,
    })
    cb({ ok = true })
end)
