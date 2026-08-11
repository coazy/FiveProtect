-- Tests for the connect gate's decision logic.
--
-- The FiveM runtime is faked, so what is under test is the resource's behaviour: which
-- identifiers it collects, what it does when the backend is unreachable, and whether a
-- denied player is told something they can act on.

local this_file = string.match(debug.getinfo(1, 'S').source, '^@(.*)$') or ''
local this_dir = string.match(this_file, '^(.*[/\\])') or './'
package.path = this_dir .. '../../../tools/lua/?.lua;' .. package.path

local paths = require('testsupport.paths')
paths.bootstrap()

local harness = require('testsupport.harness')
local fivem = require('testsupport.fivem')

local describe, it = harness.describe, harness.it
local assert_true, assert_false = harness.assert_true, harness.assert_false
local assert_equal, assert_contains, assert_nil =
    harness.assert_equal, harness.assert_contains, harness.assert_nil

--- Loads config, protocol and gate into a fresh faked runtime.
local function bootstrap(convars)
    fivem.install(convars)
    fivem.installHttp()
    fivem.load(paths, 'resources/fiveprotect/shared/protocol.lua')
    fivem.load(paths, 'resources/fiveprotect/shared/config.lua')
    fivem.load(paths, 'resources/fiveprotect/server/gate.lua')
end

local VALID_CONVARS = {
    fiveprotect_server_id = '8f14e45f-ceea-467a-9ba8-a53d9d0e0a3c',
    fiveprotect_server_key = string.rep('k', 64),
    fiveprotect_backend = 'https://api.fiveprotect.dev',
}

describe('configuration is checked before the first player', function()
    it('refuses to run without a server id', function()
        bootstrap({ fiveprotect_server_key = 'key', fiveprotect_backend = 'https://api.fiveprotect.dev' })
        local ok, err = Config.validate()
        assert_false(ok)
        assert_contains(err, 'fiveprotect_server_id')
    end)

    it('refuses to run without a server key', function()
        bootstrap({ fiveprotect_server_id = 'id', fiveprotect_backend = 'https://api.fiveprotect.dev' })
        local ok, err = Config.validate()
        assert_false(ok)
        assert_contains(err, 'fiveprotect_server_key')
    end)

    it('refuses plain http to a remote backend, because the key travels on it', function()
        bootstrap({
            fiveprotect_server_id = 'id',
            fiveprotect_server_key = 'key',
            fiveprotect_backend = 'http://api.fiveprotect.dev',
        })
        local ok, err = Config.validate()
        assert_false(ok)
        assert_contains(err, 'https')
    end)

    it('allows plain http to localhost for development', function()
        bootstrap({
            fiveprotect_server_id = 'id',
            fiveprotect_server_key = 'key',
            fiveprotect_backend = 'http://127.0.0.1:8080',
        })
        assert_true(Config.validate())
    end)
end)

describe('identifiers', function()
    it('collects only what the protocol declares', function()
        bootstrap({
            fiveprotect_server_id = 'id',
            fiveprotect_server_key = 'key',
            __identifiers = {
                'license:1100001abcdef',
                'steam:110000112345678',
                'discord:123456789',
                'xbl:987654321',
                'live:112233445566',
            },
            __endpoint = '203.0.113.42:30120',
        })

        local player = Gate.identifiersOf(1)
        assert_equal(player.license, 'license:1100001abcdef')
        assert_equal(player.steam, 'steam:110000112345678')
        assert_equal(player.discord, 'discord:123456789')
        -- Data we do not collect cannot leak. xbl and live have no place in the protocol.
        assert_nil(player.xbl)
        assert_nil(player.live)
    end)

    it('strips the port from the endpoint, or every relay check would fail', function()
        bootstrap({ __endpoint = '203.0.113.42:30120', __identifiers = { 'license:x' } })
        assert_equal(Gate.identifiersOf(1).ip, '203.0.113.42')
    end)

    it('leaves an IPv6 endpoint alone', function()
        bootstrap({ __endpoint = '2001:db8::1', __identifiers = { 'license:x' } })
        assert_equal(Gate.identifiersOf(1).ip, '2001:db8::1')
    end)
end)

describe('when the backend cannot be reached', function()
    it('lets the player in under fail-open', function()
        bootstrap(VALID_CONVARS)
        local decision = Gate.degradedDecision(true)
        assert_true(decision.allow)
        assert_true(decision.degraded, 'the incident stays visible')
    end)

    it('refuses under fail-closed and says why', function()
        bootstrap(VALID_CONVARS)
        local decision = Gate.degradedDecision(false)
        assert_false(decision.allow)
        assert_contains(decision.message, 'nicht erreichbar')
    end)

    it('reports a network failure as degraded rather than as a refusal', function()
        bootstrap(VALID_CONVARS)
        fivem.queueHttp({ ok = false, reason = 'network' })

        local result = Gate.requestNonce({ license = 'license:x', ip = '203.0.113.42' })
        assert_false(result.ok)
        -- The distinction matters: degraded means we learned nothing, and the fail mode
        -- decides. A refusal means the backend spoke, and the player is denied.
        assert_true(result.degraded)
    end)

    it('treats a malformed answer as degraded, not as the player\'s fault', function()
        bootstrap(VALID_CONVARS)
        fivem.queueHttp({ ok = true, status = 201, body = { nonce = 'too short' } })

        local result = Gate.requestNonce({ license = 'license:x', ip = '203.0.113.42' })
        assert_false(result.ok)
        assert_true(result.degraded)
        assert_contains(result.reason, 'protocol:')
    end)

    it('treats a refusal by the backend as a refusal', function()
        bootstrap(VALID_CONVARS)
        fivem.queueHttp({ ok = true, status = 403, body = { code = 'license_inactive' } })

        local result = Gate.requestNonce({ license = 'license:x', ip = '203.0.113.42' })
        assert_false(result.ok)
        assert_false(result.degraded)
        assert_equal(result.reason, 'license_inactive')
    end)
end)

describe('the nonce request', function()
    it('sends the protocol version and the configured server id', function()
        bootstrap(VALID_CONVARS)
        fivem.queueHttp({
            ok = true,
            status = 201,
            body = {
                nonce = string.rep('a', 64),
                sessionId = '1b4e28ba-2fa1-4d3b-8f2e-9c1d0e5a7b63',
                expiresAt = '2026-08-04T14:23:01.412Z',
                policyTier = 'standard',
                backendUrl = 'https://api.fiveprotect.dev',
                protocolVersion = 1,
            },
        })

        local result = Gate.requestNonce({ license = 'license:x', ip = '203.0.113.42' })
        assert_true(result.ok, tostring(result.reason))

        local call = fivem.calls.http[1]
        assert_equal(call.method, 'POST')
        assert_equal(call.path, '/v1/sessions/nonce')
        assert_equal(call.body.serverId, VALID_CONVARS.fiveprotect_server_id)
        assert_equal(call.body.protocolVersion, Protocol.PROTOCOL_VERSION)
    end)
end)

describe('the verdict poll', function()
    it('waits longer than the backend holds the request open', function()
        bootstrap(VALID_CONVARS)
        -- Otherwise the resource abandons a poll the backend is about to answer, and the
        -- player is denied for a timeout that did not happen.
        assert_true(
            Config.verdictTimeoutSeconds > Protocol.VERDICT_POLL_TIMEOUT_SECONDS,
            'resource timeout must exceed the backend long poll window'
        )
    end)

    it('rejects a verdict that does not match the protocol', function()
        bootstrap(VALID_CONVARS)
        fivem.queueHttp({
            ok = true,
            status = 200,
            body = { decision = 'maybe', sessionId = 'x', reasons = {}, requirements = {} },
        })

        local result = Gate.pollVerdict(string.rep('a', 64))
        assert_false(result.ok)
        assert_true(result.degraded)
    end)
end)
