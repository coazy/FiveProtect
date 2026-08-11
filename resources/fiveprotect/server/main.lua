--- Wires the gate into FiveM's connect lifecycle.
---
--- Everything decision-shaped lives in gate.lua and liveness.lua, which are pure enough to
--- test. This file is the part that only makes sense inside a running server.

local protocol = Protocol

local configOk, configError = Config.validate()

AddEventHandler('onResourceStart', function(resourceName)
    if resourceName ~= GetCurrentResourceName() then
        return
    end

    if not configOk then
        -- Refusing to start is the honest failure. A resource that runs without credentials
        -- would defer every player and then let them all through, which looks like working
        -- protection and is not.
        print('^1[FiveProtect] nicht gestartet: ' .. tostring(configError) .. '^0')
        print('^1[FiveProtect] Setze fiveprotect_server_id und fiveprotect_server_key in der server.cfg.^0')
        return
    end

    print(('^2[FiveProtect] bereit — Backend %s, Protokoll v%d^0'):format(
        Config.backendUrl, protocol.PROTOCOL_VERSION))
end)

AddEventHandler('playerConnecting', function(_name, setKickReason, deferrals)
    local source = source

    if not configOk then
        setKickReason('FiveProtect ist auf diesem Server nicht richtig eingerichtet.')
        CancelEvent()
        return
    end

    deferrals.defer()

    Citizen.CreateThread(function()
        Citizen.Wait(0)
        deferrals.update('FiveProtect: Systemprüfung wird vorbereitet …')

        local player = Gate.identifiersOf(source)
        if player.license == '' then
            deferrals.done('FiveProtect konnte deine Rockstar-Lizenz nicht lesen. Starte FiveM neu.')
            return
        end

        local issued = Gate.requestNonce(player)
        if not issued.ok then
            if issued.degraded then
                local decision = Gate.degradedDecision(Config.failOpenWhenBackendUnreachable)
                print(('^3[FiveProtect] Backend nicht erreichbar (%s) — %s^0'):format(
                    tostring(issued.reason),
                    decision.allow and 'Spieler durchgelassen (fail-open)' or 'Spieler abgewiesen'))
                if decision.allow then
                    deferrals.done()
                else
                    deferrals.done(decision.message)
                end
            else
                deferrals.done('FiveProtect: ' .. tostring(issued.reason))
            end
            return
        end

        local nonce = issued.nonce

        deferrals.update('FiveProtect prüft dein System … Lass die Anwendung dabei geöffnet.')

        -- ADR 0010: this does not reach a player who is still in the deferral. FiveM starts
        -- client resources only after the deferral completes, so there is no client script
        -- listening yet — the companion collects the nonce from the backend instead.
        --
        -- Sent anyway because the same event is what re-checks a player who is already in
        -- game, where the localhost hop does work (design document 5.3).
        TriggerClientEvent('fiveprotect:attest', source, {
            nonce = nonce.nonce,
            backendUrl = nonce.backendUrl,
            serverName = GetConvar('sv_projectName', 'FiveM'),
            protocolVersion = protocol.PROTOCOL_VERSION,
        })

        local polled = Gate.pollVerdict(nonce.nonce)
        if not polled.ok then
            if polled.degraded then
                local decision = Gate.degradedDecision(Config.failOpenWhenBackendUnreachable)
                print(('^3[FiveProtect] Verdikt nicht abrufbar (%s) — %s^0'):format(
                    tostring(polled.reason),
                    decision.allow and 'Spieler durchgelassen (fail-open)' or 'Spieler abgewiesen'))
                if decision.allow then
                    deferrals.done()
                else
                    deferrals.done(decision.message)
                end
            else
                deferrals.done('FiveProtect: ' .. tostring(polled.reason))
            end
            return
        end

        local verdict = polled.verdict

        if Config.verbose then
            print(('[FiveProtect] %s → %s%s'):format(
                player.license,
                verdict.decision,
                verdict.failOpen and ' (fail-open)' or ''))
        end

        if verdict.decision == 'allow' then
            if verdict.failOpen then
                -- ADR 0005: never silently. A session admitted while the backend was
                -- degraded stays identifiable afterwards.
                print(('^3[FiveProtect] %s unter fail-open zugelassen, Session %s^0'):format(
                    player.license, verdict.sessionId))
            end
            Liveness.track(source, verdict.sessionId)
            deferrals.done()
            return
        end

        deferrals.done(Gate.messageFor(verdict))
    end)
end)

AddEventHandler('playerDropped', function()
    Liveness.forget(source)
end)

Citizen.CreateThread(function()
    while true do
        Citizen.Wait(Config.livenessIntervalSeconds * 1000)
        if configOk then
            local ok, err = pcall(Liveness.poll)
            if not ok then
                print('^1[FiveProtect] Liveness-Prüfung fehlgeschlagen: ' .. tostring(err) .. '^0')
            end
        end
    end
end)
