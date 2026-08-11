-- Minimal Lua test harness shared by the protocol contract tests and the FiveM resource
-- tests.
--
-- A dependency-free harness rather than busted: the resource under test is loaded into a
-- faked FiveM runtime, and controlling the whole environment is simpler when nothing else
-- is loading modules alongside it.

local M = {}

-- Captured at load time. The FiveM fake replaces the global `print` to record what a
-- resource logged, which would otherwise swallow this harness's own output and make a
-- half-run suite look like a finished one.
local emit = print

local suites = {}
local current = nil

--- Declares a suite. Bodies run immediately; assertions are collected, not thrown.
function M.describe(name, body)
    current = { name = name, cases = {} }
    suites[#suites + 1] = current
    body()
    current = nil
end

function M.it(name, body)
    assert(current, 'it() called outside describe()')
    current.cases[#current.cases + 1] = { name = name, body = body }
end

local function format_value(value)
    if type(value) == 'string' then
        return string.format('%q', value)
    end
    if type(value) == 'table' then
        local parts = {}
        for key, item in pairs(value) do
            parts[#parts + 1] = tostring(key) .. '=' .. tostring(item)
        end
        table.sort(parts)
        return '{' .. table.concat(parts, ', ') .. '}'
    end
    return tostring(value)
end

function M.assert_true(value, message)
    if value ~= true then
        error((message or 'expected true') .. ', got ' .. format_value(value), 2)
    end
end

function M.assert_false(value, message)
    if value ~= false then
        error((message or 'expected false') .. ', got ' .. format_value(value), 2)
    end
end

function M.assert_equal(actual, expected, message)
    if actual ~= expected then
        error(
            (message or 'values differ')
                .. '\n      expected: '
                .. format_value(expected)
                .. '\n      actual:   '
                .. format_value(actual),
            2
        )
    end
end

function M.assert_nil(value, message)
    if value ~= nil then
        error((message or 'expected nil') .. ', got ' .. format_value(value), 2)
    end
end

function M.assert_contains(haystack, needle, message)
    if type(haystack) ~= 'string' or not string.find(haystack, needle, 1, true) then
        error(
            (message or 'substring not found')
                .. '\n      looking for: '
                .. format_value(needle)
                .. '\n      inside:      '
                .. format_value(haystack),
            2
        )
    end
end

--- Runs everything declared so far. Returns the number of failures.
function M.run()
    local passed, failed = 0, 0
    local failures = {}

    for _, suite in ipairs(suites) do
        emit('\n  ' .. suite.name)
        for _, case in ipairs(suite.cases) do
            local ok, err = pcall(case.body)
            if ok then
                passed = passed + 1
                emit('    PASS  ' .. case.name)
            else
                failed = failed + 1
                emit('    FAIL  ' .. case.name)
                failures[#failures + 1] = { suite = suite.name, case = case.name, err = err }
            end
        end
    end

    if failed > 0 then
        emit('\n  Failures:')
        for _, failure in ipairs(failures) do
            emit('\n    ' .. failure.suite .. ' > ' .. failure.case)
            emit('      ' .. tostring(failure.err))
        end
    end

    emit(string.format('\n  %d passed, %d failed\n', passed, failed))
    return failed
end

--- Clears state so several suite files can run in one process.
function M.reset()
    suites = {}
    current = nil
end

return M
