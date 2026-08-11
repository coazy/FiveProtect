-- Lua half of the protocol contract tests.
--
-- Reads the same fixtures TypeScript, Rust and C++ read. The point is not that Lua can
-- parse JSON — it is that all four languages agree on which payloads are acceptable. A
-- fixture the backend rejects but the resource waves through is exactly the drift the
-- protocol layer exists to prevent.

-- Self-bootstrap so the suite runs both on its own and through tools/lua/run-all.lua.
-- The path is derived from this file rather than the working directory.
local this_file = string.match(debug.getinfo(1, 'S').source, '^@(.*)$') or ''
local this_dir = string.match(this_file, '^(.*[/\\])') or './'
package.path = this_dir .. '../../../tools/lua/?.lua;' .. package.path

local paths = require('testsupport.paths')
paths.bootstrap()

local harness = require('testsupport.harness')
local json = require('testsupport.json')
local protocol = require('protocol')

local describe, it = harness.describe, harness.it
local assert_true, assert_false = harness.assert_true, harness.assert_false
local assert_equal, assert_contains = harness.assert_equal, harness.assert_contains

local index = json.decode(paths.read('packages/protocol/fixtures/index.json'))

local function read_fixture(relative)
    return json.decode(paths.read('packages/protocol/fixtures/' .. relative))
end

local function validator_for(schema_name)
    local validator = protocol.validate[schema_name]
    assert(validator, 'no Lua validator for schema ' .. schema_name)
    return validator
end

describe('generated module', function()
    it('exposes the protocol version', function()
        assert_equal(protocol.PROTOCOL_VERSION, 1, 'protocol version')
    end)

    it('exposes the constants the resource depends on', function()
        assert_equal(protocol.NONCE_TTL_SECONDS, 30)
        assert_equal(protocol.HEARTBEAT_INTERVAL_SECONDS, 120)
        assert_equal(protocol.HEARTBEAT_GRACE_SECONDS, 90)
        assert_equal(protocol.VERDICT_POLL_TIMEOUT_SECONDS, 20)
        assert_equal(protocol.LOCAL_PORT_RANGE_START, 52800)
        assert_equal(protocol.LOCAL_PORT_RANGE_END, 52899)
    end)

    it('has a validator for every declared schema', function()
        for _, name in ipairs(protocol.schema_names) do
            assert_true(
                type(protocol.validate[name]) == 'function',
                'missing validator for ' .. name
            )
        end
    end)

    it('lists the enum values the resource maps to player-facing text', function()
        local tiers = {}
        for _, value in ipairs(protocol.enums.PolicyTier) do
            tiers[value] = true
        end
        assert_true(tiers.relaxed and tiers.standard and tiers.strict, 'policy tiers')
    end)
end)

describe('valid fixtures', function()
    for _, entry in ipairs(index.valid) do
        it(entry.file .. ' passes ' .. entry.schema, function()
            local ok, err = validator_for(entry.schema)(read_fixture(entry.file))
            assert_true(ok, entry.file .. ' should be valid but failed: ' .. tostring(err))
        end)
    end
end)

describe('invalid fixtures', function()
    for _, entry in ipairs(index.invalid) do
        it(entry.file .. ' is rejected — ' .. entry.reason, function()
            local ok, err = validator_for(entry.schema)(read_fixture(entry.file))
            assert_false(ok, entry.file .. ' should have been rejected')
            assert_true(type(err) == 'string' and #err > 0, 'rejection must carry a message')
        end)
    end
end)

describe('error messages name the offending field', function()
    it('points at a nested field', function()
        local snapshot = read_fixture('valid/system-snapshot-full.json')
        snapshot.features.hvci = 'maybe'
        local ok, err = protocol.validate.SystemSnapshot(snapshot)
        assert_false(ok)
        assert_contains(err, 'SystemSnapshot.features.hvci')
    end)

    it('points at an array element', function()
        local verdict = read_fixture('valid/verdict-deny-hvci.json')
        verdict.requirements[2].status = 'probably'
        local ok, err = protocol.validate.Verdict(verdict)
        assert_false(ok)
        assert_contains(err, 'Verdict.requirements[2].status')
    end)

    it('names an unexpected field rather than ignoring it', function()
        local snapshot = read_fixture('valid/system-snapshot-full.json')
        snapshot.clean = true
        local ok, err = protocol.validate.SystemSnapshot(snapshot)
        assert_false(ok, 'a companion never sends a judgement — ADR 0004')
        assert_contains(err, 'clean')
    end)
end)

describe('optional fields', function()
    it('accepts a snapshot without a game process', function()
        local snapshot = read_fixture('valid/system-snapshot-full.json')
        snapshot.gameProcess = nil
        assert_true(protocol.validate.SystemSnapshot(snapshot))
    end)

    it('still validates an optional field when it is present', function()
        local snapshot = read_fixture('valid/system-snapshot-full.json')
        snapshot.gameProcess.pid = 0
        local ok, err = protocol.validate.SystemSnapshot(snapshot)
        assert_false(ok, 'pid 0 is below the declared minimum')
        assert_contains(err, 'gameProcess.pid')
    end)
end)

return harness
