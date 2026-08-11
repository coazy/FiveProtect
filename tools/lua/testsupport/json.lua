-- Minimal JSON decoder for the Lua contract tests.
--
-- Test support only. Inside FiveM the runtime provides a `json` global, so the resource
-- never loads this file; it exists so `lua contract_test.lua` can read the shared fixtures
-- without a package manager on the test machine.

local M = {}

--- Sentinel for JSON null. The protocol uses absence rather than null, so a decoded value
--- equal to this is a payload error rather than a normal case.
M.null = setmetatable({}, { __tostring = function() return 'json.null' end })

local escapes = {
    ['"'] = '"',
    ['\\'] = '\\',
    ['/'] = '/',
    b = '\b',
    f = '\f',
    n = '\n',
    r = '\r',
    t = '\t',
}

local function skip_whitespace(text, pos)
    local _, stop = string.find(text, '^[ \t\r\n]*', pos)
    return stop + 1
end

local decode_value

local function decode_error(text, pos, message)
    local line = 1
    for _ in string.gmatch(string.sub(text, 1, pos), '\n') do
        line = line + 1
    end
    error(string.format('json: %s at line %d (offset %d)', message, line, pos), 0)
end

local function codepoint_to_utf8(codepoint)
    if utf8 and utf8.char then
        return utf8.char(codepoint)
    end
    -- Lua 5.1 fallback; kept so the harness also runs under LuaJIT.
    if codepoint < 0x80 then
        return string.char(codepoint)
    elseif codepoint < 0x800 then
        return string.char(0xC0 + math.floor(codepoint / 0x40), 0x80 + codepoint % 0x40)
    end
    return string.char(
        0xE0 + math.floor(codepoint / 0x1000),
        0x80 + math.floor(codepoint / 0x40) % 0x40,
        0x80 + codepoint % 0x40
    )
end

local function decode_string(text, pos)
    local out = {}
    pos = pos + 1
    while true do
        local char = string.sub(text, pos, pos)
        if char == '' then
            decode_error(text, pos, 'unterminated string')
        elseif char == '"' then
            return table.concat(out), pos + 1
        elseif char == '\\' then
            local escape = string.sub(text, pos + 1, pos + 1)
            if escape == 'u' then
                local hex = string.sub(text, pos + 2, pos + 5)
                local codepoint = tonumber(hex, 16)
                if not codepoint then
                    decode_error(text, pos, 'invalid \\u escape')
                end
                out[#out + 1] = codepoint_to_utf8(codepoint)
                pos = pos + 6
            elseif escapes[escape] then
                out[#out + 1] = escapes[escape]
                pos = pos + 2
            else
                decode_error(text, pos, 'unknown escape \\' .. escape)
            end
        else
            out[#out + 1] = char
            pos = pos + 1
        end
    end
end

local function decode_number(text, pos)
    local literal = string.match(text, '^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
    local value = tonumber(literal)
    if not value then
        decode_error(text, pos, 'invalid number')
    end
    return value, pos + #literal
end

local function decode_array(text, pos)
    local out = {}
    pos = skip_whitespace(text, pos + 1)
    if string.sub(text, pos, pos) == ']' then
        return out, pos + 1
    end
    while true do
        local value
        value, pos = decode_value(text, pos)
        out[#out + 1] = value
        pos = skip_whitespace(text, pos)
        local char = string.sub(text, pos, pos)
        if char == ',' then
            pos = skip_whitespace(text, pos + 1)
        elseif char == ']' then
            return out, pos + 1
        else
            decode_error(text, pos, 'expected , or ] in array')
        end
    end
end

local function decode_object(text, pos)
    local out = {}
    pos = skip_whitespace(text, pos + 1)
    if string.sub(text, pos, pos) == '}' then
        return out, pos + 1
    end
    while true do
        if string.sub(text, pos, pos) ~= '"' then
            decode_error(text, pos, 'expected a string key')
        end
        local key
        key, pos = decode_string(text, pos)
        pos = skip_whitespace(text, pos)
        if string.sub(text, pos, pos) ~= ':' then
            decode_error(text, pos, 'expected : after key')
        end
        pos = skip_whitespace(text, pos + 1)
        local value
        value, pos = decode_value(text, pos)
        out[key] = value
        pos = skip_whitespace(text, pos)
        local char = string.sub(text, pos, pos)
        if char == ',' then
            pos = skip_whitespace(text, pos + 1)
        elseif char == '}' then
            return out, pos + 1
        else
            decode_error(text, pos, 'expected , or } in object')
        end
    end
end

decode_value = function(text, pos)
    pos = skip_whitespace(text, pos)
    local char = string.sub(text, pos, pos)
    if char == '{' then
        return decode_object(text, pos)
    elseif char == '[' then
        return decode_array(text, pos)
    elseif char == '"' then
        return decode_string(text, pos)
    elseif string.sub(text, pos, pos + 3) == 'true' then
        return true, pos + 4
    elseif string.sub(text, pos, pos + 4) == 'false' then
        return false, pos + 5
    elseif string.sub(text, pos, pos + 3) == 'null' then
        return M.null, pos + 4
    elseif string.match(char, '[%d-]') then
        return decode_number(text, pos)
    end
    decode_error(text, pos, 'unexpected character ' .. string.format('%q', char))
end

--- Decodes a JSON document. Raises on malformed input.
function M.decode(text)
    local value, pos = decode_value(text, 1)
    pos = skip_whitespace(text, pos)
    if pos <= #text then
        decode_error(text, pos, 'trailing content')
    end
    return value
end

return M
