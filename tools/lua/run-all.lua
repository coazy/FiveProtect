-- Runs every Lua suite in the repository in one process.
--
-- Suites are listed rather than discovered: the list is short, and an explicit list makes
-- an accidentally unregistered suite visible in a diff instead of silently never running.

local this_file = string.match(debug.getinfo(1, 'S').source, '^@(.*)$') or ''
local this_dir = string.match(this_file, '^(.*[/\\])') or './'
package.path = this_dir .. '?.lua;' .. package.path

local paths = require('testsupport.paths')
paths.bootstrap()

local harness = require('testsupport.harness')

-- Captured before any suite runs. A suite that installs the FiveM fake replaces the global
-- `print`, and the runner's own output must survive that.
local emit = print

local suites = {
    'packages/protocol/lua/contract_test.lua',
    'resources/fiveprotect/tests/gate_test.lua',
    'resources/fiveprotect/tests/verdict_text_test.lua',
}

local root = paths.repo_root()
local total_failures = 0

for _, relative in ipairs(suites) do
    local path = root .. relative
    local handle = io.open(path, 'r')
    if not handle then
        emit('\nMISSING SUITE: ' .. relative)
        total_failures = total_failures + 1
    else
        handle:close()
        emit('\n=== ' .. relative .. ' ===')
        harness.reset()
        local chunk, load_error = loadfile(path)
        if not chunk then
            emit('  LOAD ERROR: ' .. tostring(load_error))
            total_failures = total_failures + 1
        else
            local ok, run_error = pcall(chunk)
            if not ok then
                emit('  ERROR: ' .. tostring(run_error))
                total_failures = total_failures + 1
            else
                total_failures = total_failures + harness.run()
            end
        end
    end
end

if total_failures > 0 then
    emit(string.format('Lua suites failed: %d failure(s)', total_failures))
    os.exit(1)
end

emit('All Lua suites passed.')
