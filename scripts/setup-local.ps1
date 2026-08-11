<#
.SYNOPSIS
    Richtet eine lokale FiveProtect-Umgebung ein: Datenbank, .env, Migrationen, Testmandant.

.DESCRIPTION
    Einmalig ausführen, danach reicht `npm run -w @fiveprotect/backend dev`.

    Standardmäßig wird eine eigene PostgreSQL-Instanz angelegt — eigenes Datenverzeichnis,
    eigener Port, zufällig erzeugtes Passwort. Das ist ohne Rückfrage durchführbar und lässt
    eine bereits installierte PostgreSQL-Instanz vollständig in Ruhe. Nichts hört auf einem
    Standardport, nichts läuft ohne Authentifizierung.

    Mit -UseSystemPostgres wird stattdessen eine laufende Instanz verwendet; dann wird nach
    dem Superuser-Passwort gefragt.

    Der Aufruf ist wiederholbar: ein vorhandener Cluster wird gestartet, nicht neu angelegt.

.EXAMPLE
    .\scripts\setup-local.ps1
    .\scripts\setup-local.ps1 -UseSystemPostgres -PgPort 5432
#>
[CmdletBinding()]
param(
    [switch] $UseSystemPostgres,
    [string] $PgHost = '127.0.0.1',
    [int]    $PgPort = 55432,
    [string] $PgSuperUser = 'postgres',
    [string] $Role = 'fiveprotect',
    [string] $Database = 'fiveprotect',
    [string] $ServerName = 'Lokaler Testserver',
    [ValidateSet('relaxed', 'standard', 'strict')]
    [string] $Tier = 'standard',
    [int]    $BackendPort = 8080,
    [string] $DataDir = (Join-Path $env:LOCALAPPDATA 'FiveProtect\pgdata')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }

# psql liefert bei null Treffern gar nichts, und $null.Trim() ist ein Laufzeitfehler.
function Test-Found($result) { ("$result").Trim() -eq '1' }

function New-Secret([int] $bytes) {
    # RNGCryptoServiceProvider statt RandomNumberGenerator::Fill: Windows PowerShell 5.1
    # läuft auf dem .NET Framework, das Fill erst ab .NET Core 3.0 kennt. Get-Random ist
    # kein Ersatz — es ist nicht kryptografisch.
    $buffer = New-Object byte[] $bytes
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

# --- PostgreSQL-Programme finden -------------------------------------------------------

function Find-PgBin {
    $probe = Get-Command psql -ErrorAction SilentlyContinue
    if ($probe) { return (Split-Path -Parent $probe.Source) }

    $newest = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Name -replace '\D', '0') } -Descending | Select-Object -First 1
    if ($newest) {
        $bin = Join-Path $newest.FullName 'bin'
        if (Test-Path (Join-Path $bin 'psql.exe')) { return $bin }
    }
    throw "PostgreSQL nicht gefunden. Erwartet wurde psql im PATH oder unter C:\Program Files\PostgreSQL."
}

Step 'Voraussetzungen prüfen'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node nicht gefunden. Node.js >= 22 installieren.'
}
$pgBin = Find-PgBin
Ok "PostgreSQL-Programme: $pgBin"
Ok "Node: $((Get-Command node).Source)"

$psql = Join-Path $pgBin 'psql.exe'
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'

# --- Datenbankinstanz ------------------------------------------------------------------

$rolePassword = $null

if ($UseSystemPostgres) {
    Step "Vorhandene Instanz auf ${PgHost}:${PgPort} verwenden"

    $secure = Read-Host -Prompt "Passwort für die PostgreSQL-Rolle '$PgSuperUser'" -AsSecureString
    $env:PGPASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

    $probe = & $psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -tAc 'select 1' 2>&1
    if ($LASTEXITCODE -ne 0) { $env:PGPASSWORD = $null; throw "Anmeldung fehlgeschlagen: $probe" }

    $rolePassword = New-Secret 24

    $exists = & $psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -tAc `
        "select 1 from pg_roles where rolname = '$Role'"
    $verb = if (Test-Found $exists) { 'alter' } else { 'create' }
    & $psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -q -c `
        "$verb role `"$Role`" with login password '$rolePassword'" | Out-Null
    Ok "Rolle '$Role' eingerichtet"

    $dbExists = & $psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -tAc `
        "select 1 from pg_database where datname = '$Database'"
    if (-not (Test-Found $dbExists)) {
        & $psql -U $PgSuperUser -h $PgHost -p $PgPort -d postgres -q -c `
            "create database `"$Database`" owner `"$Role`"" | Out-Null
        Ok "Datenbank '$Database' angelegt"
    } else {
        Warn "Datenbank '$Database' existierte bereits"
    }

    # Ab PostgreSQL 15 darf nicht mehr jede Rolle im Schema public anlegen.
    & $psql -U $PgSuperUser -h $PgHost -p $PgPort -d $Database -q -c `
        "grant all on schema public to `"$Role`"" | Out-Null

    $env:PGPASSWORD = $null
} else {
    Step "Eigene PostgreSQL-Instanz in $DataDir"

    $secretFile = Join-Path (Split-Path -Parent $DataDir) 'role-password'

    if (Test-Path (Join-Path $DataDir 'PG_VERSION')) {
        Warn 'Instanz existiert bereits und wird weiterverwendet'
        if (-not (Test-Path $secretFile)) {
            throw "Datenverzeichnis vorhanden, aber $secretFile fehlt. Zum Neuaufsetzen: Remove-Item -Recurse '$DataDir'"
        }
        $rolePassword = (Get-Content $secretFile -Raw).Trim()
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DataDir) | Out-Null
        $rolePassword = New-Secret 24

        # Das Passwort geht über eine Datei an initdb, nicht über die Kommandozeile: Argumente
        # sind auf dem eigenen Rechner für jeden anderen Prozess sichtbar.
        $pwFile = Join-Path ([System.IO.Path]::GetTempPath()) "fiveprotect-initdb-$PID"
        try {
            Set-Content -Path $pwFile -Value $rolePassword -NoNewline -Encoding ascii
            & $initdb --pgdata=$DataDir --username=$Role --pwfile=$pwFile `
                --auth=scram-sha-256 --encoding=UTF8 --locale=C 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'initdb fehlgeschlagen.' }
        } finally {
            Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
        }

        Set-Content -Path $secretFile -Value $rolePassword -NoNewline -Encoding ascii
        Ok "Instanz angelegt, Rolle '$Role' mit zufälligem Passwort"
    }

    # Nur Loopback, eigener Port: die Instanz ist von außen nicht erreichbar.
    $logFile = Join-Path (Split-Path -Parent $DataDir) 'postgres.log'
    & $pgCtl --pgdata=$DataDir status *> $null
    if ($LASTEXITCODE -ne 0) {
        # Über Start-Process mit umgeleiteten Datenströmen, nicht über die Pipeline: der
        # gestartete Server erbt sonst das Ausgabe-Handle, und die Pipeline wartet auf ein
        # Dateiende, das erst kommt, wenn die Datenbank wieder heruntergefahren wird.
        $noise = Join-Path ([System.IO.Path]::GetTempPath()) "fiveprotect-pgctl-$PID"
        $started = Start-Process -FilePath $pgCtl -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput "$noise.out" -RedirectStandardError "$noise.err" `
            -ArgumentList @(
                "--pgdata=$DataDir", "--log=$logFile",
                "--options=-p $PgPort -h $PgHost", '--wait', 'start')
        Remove-Item "$noise.out", "$noise.err" -Force -ErrorAction SilentlyContinue
        if ($started.ExitCode -ne 0) { throw "Start fehlgeschlagen. Protokoll: $logFile" }
        Ok "Gestartet auf ${PgHost}:${PgPort}"
    } else {
        Ok "Läuft bereits auf ${PgHost}:${PgPort}"
    }

    $env:PGPASSWORD = $rolePassword
    $dbExists = & $psql -U $Role -h $PgHost -p $PgPort -d postgres -tAc `
        "select 1 from pg_database where datname = '$Database'"
    if (-not (Test-Found $dbExists)) {
        & $psql -U $Role -h $PgHost -p $PgPort -d postgres -q -c `
            "create database `"$Database`" owner `"$Role`"" | Out-Null
        Ok "Datenbank '$Database' angelegt"
    } else {
        Warn "Datenbank '$Database' existierte bereits"
    }
    $env:PGPASSWORD = $null
}

# --- .env ------------------------------------------------------------------------------

Step 'services/backend/.env schreiben'

$envPath = Join-Path $repo 'services/backend/.env'
if (Test-Path $envPath) {
    Copy-Item $envPath "$envPath.bak" -Force
    Warn "Bestehende .env gesichert nach $envPath.bak"
}

@"
# Lokale Entwicklungsumgebung. Nicht committen.
DATABASE_URL=postgres://${Role}:${rolePassword}@${PgHost}:${PgPort}/${Database}
HOST=127.0.0.1
PORT=$BackendPort
LOG_LEVEL=info
PUBLIC_BASE_URL=http://127.0.0.1:$BackendPort
NONCE_SEAL_KEY=$(New-Secret 32)
TRUST_PROXY=false
NODE_ENV=development
"@ | Set-Content -Path $envPath -Encoding utf8

Ok 'geschrieben, mit zufälligem NONCE_SEAL_KEY'

# --- Migrationen und Mandant -----------------------------------------------------------

Push-Location $repo
try {
    Step 'Migrationen einspielen'
    & npm run -w '@fiveprotect/backend' --silent migrate
    if ($LASTEXITCODE -ne 0) { throw 'Migration fehlgeschlagen.' }
    Ok 'Schema aktuell'

    Step "Mandant '$ServerName' anlegen (Tier: $Tier)"
    & npm run -w '@fiveprotect/backend' --silent provision -- $ServerName --tier $Tier
    if ($LASTEXITCODE -ne 0) { throw 'Provisionierung fehlgeschlagen.' }
} finally {
    Pop-Location
}

# --- Companion-Origin ------------------------------------------------------------------

Step 'Companion auf das lokale Backend zeigen lassen'

$settingsJson = "{`"allowedBackends`":[`"http://127.0.0.1:$BackendPort`"]}"
$exeDir = Join-Path $repo 'target/release'
if (Test-Path $exeDir) {
    Set-Content -Path (Join-Path $exeDir 'fiveprotect.json') -Value $settingsJson -Encoding utf8
    Ok 'fiveprotect.json neben target/release/FiveProtect.exe geschrieben'
} else {
    Warn 'target/release fehlt. Nach dem Bauen dort anlegen:'
    Warn "  $settingsJson"
}

Write-Host @"

Fertig. Was jetzt noch zu tun ist:

  1. Backend starten:
       npm run -w @fiveprotect/backend dev

  2. server.cfg des FiveM-Servers (serverId und serverKey aus der Ausgabe oben):
       set fiveprotect_backend    "http://127.0.0.1:$BackendPort"
       set fiveprotect_server_id  "<serverId>"
       set fiveprotect_server_key "<serverKey>"
       ensure fiveprotect

  3. Ordner resources/fiveprotect in das resources-Verzeichnis des Servers kopieren.

  4. Companion starten: target\release\FiveProtect.exe

  5. Verbinden.

Die Datenbank läuft als eigener Prozess auf ${PgHost}:${PgPort}. Nach einem Neustart des
Rechners dieses Skript erneut aufrufen — es startet den vorhandenen Cluster, ohne etwas
neu anzulegen.

"@ -ForegroundColor Cyan
