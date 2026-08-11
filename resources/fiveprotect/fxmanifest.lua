fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'fiveprotect'
author 'coazy'
description 'FiveProtect connect gate — defers a connecting player until the companion has attested.'
version '0.1.0'

shared_scripts {
    'shared/protocol.lua',
    'shared/config.lua',
}

server_scripts {
    'server/http.lua',
    'server/gate.lua',
    'server/liveness.lua',
    'server/main.lua',
}

client_scripts {
    'client/main.lua',
}

files {
    'nui/index.html',
    'nui/transport.js',
}

ui_page 'nui/index.html'

-- The resource reads no player files and writes nothing to disk. Everything it learns about
-- the machine comes from the companion, through the backend — never from the game client.
