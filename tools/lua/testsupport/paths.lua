-- Locates the repository root from a script's own path, so the Lua suites run the same way
-- from the repository root, from a package directory, or from CI.

local M = {}

-- Captured at load time: debug.getinfo(1) is this file regardless of who calls in later.
local this_file = string.match(debug.getinfo(1, 'S').source, '^@(.*)$') or ''
local this_dir = string.match(this_file, '^(.*[/\\])') or './'

--- Repository root, derived from this file's location (tools/lua/testsupport).
function M.repo_root()
    return this_dir .. '../../../'
end

--- Adds the repository's Lua directories to package.path exactly once.
function M.bootstrap()
    local root = M.repo_root()
    local entries = {
        root .. 'tools/lua/?.lua',
        root .. 'packages/protocol/generated/lua/?.lua',
        root .. 'resources/fiveprotect/?.lua',
    }
    for _, entry in ipairs(entries) do
        if not string.find(package.path, entry, 1, true) then
            package.path = entry .. ';' .. package.path
        end
    end
    return root
end

--- Reads a whole file relative to the repository root.
function M.read(relative_path)
    local root = M.repo_root()
    local handle, err = io.open(root .. relative_path, 'r')
    if not handle then
        error('cannot open ' .. relative_path .. ': ' .. tostring(err), 0)
    end
    local contents = handle:read('a')
    handle:close()
    return contents
end

return M
