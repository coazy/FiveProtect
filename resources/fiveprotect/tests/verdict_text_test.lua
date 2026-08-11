-- What a denied player actually reads.
--
-- Design document 12.2: the block screen is where the support load is decided. A reason
-- code on screen produces a ticket; a concrete instruction does not. These tests are about
-- that difference, so they assert on content rather than on a string being non-empty.

local this_file = string.match(debug.getinfo(1, 'S').source, '^@(.*)$') or ''
local this_dir = string.match(this_file, '^(.*[/\\])') or './'
package.path = this_dir .. '../../../tools/lua/?.lua;' .. package.path

local paths = require('testsupport.paths')
paths.bootstrap()

local harness = require('testsupport.harness')
local fivem = require('testsupport.fivem')

local describe, it = harness.describe, harness.it
local assert_contains, assert_true = harness.assert_contains, harness.assert_true

fivem.install({})
fivem.installHttp()
fivem.load(paths, 'resources/fiveprotect/shared/protocol.lua')
fivem.load(paths, 'resources/fiveprotect/shared/config.lua')
fivem.load(paths, 'resources/fiveprotect/server/gate.lua')
fivem.load(paths, 'resources/fiveprotect/server/liveness.lua')

describe('the kick message', function()
    it('uses the backend text, because only the backend knows the cause', function()
        local message = Gate.messageFor({
            decision = 'deny',
            reasons = { 'policy_not_met' },
            remediation = 'Die Speicherintegrität ist abgeschaltet, weil rtcore64.sys sie blockiert.',
        })
        assert_contains(message, 'rtcore64.sys')
    end)

    it('falls back to readable text when the backend sent none', function()
        local message = Gate.messageFor({ decision = 'deny', reasons = { 'companion_missing' } })
        assert_contains(message, 'FiveProtect läuft nicht')
    end)

    it('never shows a bare reason code to a player', function()
        local codes = { 'policy_not_met', 'network_origin_mismatch', 'attestation_invalid' }
        for _, code in ipairs(codes) do
            local message = Gate.messageFor({ decision = 'deny', reasons = { code } })
            assert_true(
                string.find(message, code, 1, true) == nil,
                'the message leaked the reason code ' .. code
            )
            assert_true(#message > 20, 'the message for ' .. code .. ' is too short to act on')
        end
    end)

    it('says something useful even for a verdict with no reasons at all', function()
        local message = Gate.messageFor({ decision = 'deny', reasons = {} })
        assert_contains(message, 'FiveProtect')
    end)

    it('ignores an empty remediation string rather than showing a blank screen', function()
        local message = Gate.messageFor({
            decision = 'deny',
            reasons = { 'companion_missing' },
            remediation = '',
        })
        assert_contains(message, 'FiveProtect läuft nicht')
    end)
end)

describe('the liveness decision', function()
    it('does nothing while the heartbeat is on time', function()
        local action = Liveness.decide({ shouldKick = false }, false)
        assert_true(action.kick == false and action.warn == false)
    end)

    it('warns once when the grace period is running', function()
        local first = Liveness.decide({ shouldKick = false, graceExpiresAt = 'later' }, false)
        assert_true(first.warn, 'the player should be warned before being removed')

        local second = Liveness.decide({ shouldKick = false, graceExpiresAt = 'later' }, true)
        assert_true(second.warn == false, 'the warning should not repeat on every poll')
    end)

    it('kicks once the grace period has run out', function()
        local action = Liveness.decide({ shouldKick = true, reason = 'heartbeat_lost' }, true)
        assert_true(action.kick)
        assert_true(action.reason == 'heartbeat_lost')
    end)

    it('names the ban rather than blaming the companion', function()
        assert_contains(FallbackKickText('banned'), 'gesperrt')
    end)

    it('explains a missing game process in terms a player can act on', function()
        assert_contains(FallbackKickText('game_process_missing'), 'demselben PC')
    end)
end)
