<#
.SYNOPSIS
    Richtet eine lokale FiveProtect-Umgebung ein: Datenbank, .env, Migrationen, Testmandant.

.DESCRIPTION
    Einmalig ausführen. Danach reicht `npm run -w @fiveprotect/backend dev`.

    Das Skript legt Rolle und Datenbank in einer laufenden PostgreSQL-Instanz an, schreibt
    services/backend/.env mit einem frisch erzeugten NONCE_SEAL_KEY, spielt die Migrationen
    ein und legt einen Mandanten an. Am Ende stehen die Zeilen für die server.cfg auf dem
    Bildschirm.

    Nach dem Superuser-Passwort wird gefragt; es steht nirgends im Klartext und landet nicht
    in der .env — dort steht nur das Passwort der neu angelegten Rolle.

.EXAMPLE
    .\scripts\setup-local.ps1
    .\scripts\setup-local.ps1 -PgPort 55432 -ServerName "Mein Testserver"
#>
[CmdletBinding()]
param(
    [string] $PgHost = '127.0.0.1',
    [int]    $PgPort = 5432,
    [string] $PgSuperUser = 'postgres',
    [string] $Role = 'fiveprotect',
    [string] $Database = 'fiveprotect',
    [string] $ServerName = 'Lokaler Testserver',
    [ValidateSet('relaxed', 'standard', 'strict')]
    [string] $Tier = 'standard',
    [int]    $BackendPort = 8080
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }

# --- Voraussetzungen -------------------------------------------------------------------

Step 'Voraussetzungen prüfen'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw "psql nicht gefunden. PostgreSQL installieren oder dessen bin-Verzeichnis in den PATH aufnehmen."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node nicht gefunden. Node.js >= 22 installieren."
}

$reachable = Test-NetConnection -ComputerName $PgHost -Port $PgPort -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $reachable) {
    throw "Auf ${PgHost}:${PgPort} lauscht nichts. Läuft PostgreSQL? (Get-Service *postgres*)"
}
Ok "PostgreSQL erreichbar auf ${PgHost}:${PgPort}"

# --- Superuser-Zugang ------------------------------------------------------------------

Step "Zugang als Superuser '$PgSuperUser'"

$secure = Read-Host -Prompt "Passwort für die PostgreSQL-Rolle '$PgSuperUser'" -AsSecureString
$env:PGPASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$probe = & psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -tAc 'select 1' 2>&1
if ($LASTEXITCODE -ne 0) {
    $env:PGPASSWORD = $null
    throw "Anmeldung fehlgeschlagen: $probe"
}
Ok 'Anmeldung erfolgreich'

# --- Rolle und Datenbank ---------------------------------------------------------------

Step "Rolle '$Role' und Datenbank '$Database' anlegen"

# Eigenes Passwort für die Anwendungsrolle. Der Superuser-Zugang gehört nicht in eine .env.
$bytes = [byte[]]::new(24)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$rolePassword = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')

$roleExists = & psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -tAc `
    "select 1 from pg_roles where rolname = '$Role'"

if ($roleExists.Trim() -eq '1') {
    & psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -q -c `
        "alter role `"$Role`" with login password '$rolePassword'" | Out-Null
    Ok "Rolle '$Role' existierte, Passwort neu gesetzt"
} else {
    & psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -q -c `
        "create role `"$Role`" with login password '$rolePassword'" | Out-Null
    Ok "Rolle '$Role' angelegt"
}

$dbExists = & psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -tAc `
    "select 1 from pg_database where datname = '$Database'"

if ($dbExists.Trim() -eq '1') {
    Warn "Datenbank '$Database' existiert bereits und wird weiterverwendet"
} else {
    & psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -q -c `
        "create database `"$Database`" owner `"$Role`"" | Out-Null
    Ok "Datenbank '$Database' angelegt"
}

# Die Migrationen legen Tabellen im Schema public an; ab PostgreSQL 15 darf das nicht mehr
# jede Rolle, deshalb ausdrücklich.
& psql -U $PgSuperUser -h $PgHost -p $PgPort -d $Database -q -c `
    "grant all on schema public to `"$Role`"" | Out-Null

$env:PGPASSWORD = $null

# --- .env ------------------------------------------------------------------------------

Step 'services/backend/.env schreiben'

$envPath = Join-Path $repo 'services/backend/.env'
if (Test-Path $envPath) {
    $backup = "$envPath.bak"
    Copy-Item $envPath $backup -Force
    Warn "Bestehende .env gesichert nach $backup"
}

$sealBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($sealBytes)
$sealKey = ($sealBytes | ForEach-Object { $_.ToString('x2') }) -join ''

$databaseUrl = "postgres://${Role}:${rolePassword}@${PgHost}:${PgPort}/${Database}"

@"
# Lokale Entwicklungsumgebung. Nicht committen.
DATABASE_URL=$databaseUrl
HOST=127.0.0.1
PORT=$BackendPort
LOG_LEVEL=info
PUBLIC_BASE_URL=http://127.0.0.1:$BackendPort
NONCE_SEAL_KEY=$sealKey
TRUST_PROXY=false
NODE_ENV=development
"@ | Set-Content -Path $envPath -Encoding utf8

Ok 'geschrieben, mit frischem NONCE_SEAL_KEY'

# --- Migrationen und Mandant -----------------------------------------------------------

Step 'Migrationen einspielen'
Push-Location $repo
try {
    & npm run -w '@fiveprotect/backend' migrate
    if ($LASTEXITCODE -ne 0) { throw 'Migration fehlgeschlagen.' }
    Ok 'Schema aktuell'

    Step "Mandant '$ServerName' anlegen (Tier: $Tier)"
    $provision = & npm run -w '@fiveprotect/backend' --silent provision -- $ServerName --tier $Tier 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Provisionierung fehlgeschlagen: $provision" }
    $provision | Write-Host
} finally {
    Pop-Location
}

# --- Companion-Origin ------------------------------------------------------------------

Step 'Companion auf das lokale Backend zeigen lassen'

$settingsJson = "{`"allowedBackends`":[`"http://127.0.0.1:$BackendPort`"]}"
$exeDir = Join-Path $repo 'target/release'
if (Test-Path $exeDir) {
    $settingsJson | Set-Content -Path (Join-Path $exeDir 'fiveprotect.json') -Encoding utf8
    Ok "fiveprotect.json neben target/release/FiveProtect.exe geschrieben"
} else {
    Warn "target/release fehlt — nach 'cargo build --release -p fiveprotect-companion' anlegen:"
    Warn "  $settingsJson"
}

Write-Host @"

Fertig. Was jetzt noch zu tun ist:

  1. Backend starten:
       npm run -w @fiveprotect/backend dev

  2. In die server.cfg des FiveM-Servers (Werte aus der Ausgabe oben):
       set fiveprotect_backend    "http://127.0.0.1:$BackendPort"
       set fiveprotect_server_id  "<serverId von oben>"
       set fiveprotect_server_key "<serverKey von oben — wird nur einmal angezeigt>"
       ensure fiveprotect

  3. Ordner resources/fiveprotect in das resources-Verzeichnis des Servers kopieren.

  4. Companion starten:
       target\release\FiveProtect.exe

  5. Verbinden.

"@ -ForegroundColor Cyan
