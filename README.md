# FiveProtect

**Hardware-gestütztes Anticheat für FiveM.** Serverautoritative Erkennung in der Resource
plus eine Companion-Anwendung, die den Systemzustand des Spielers über TPM-Remote-Attestation
kryptografisch beglaubigt — statt ihn zu behaupten.

> **Status: ca. 80 % — pausiert.** Läuft Ende-zu-Ende, ist aber nicht fertig und wird gerade
> nicht weiterentwickelt. Details unter [Projektstatus](#projektstatus).
> Es gibt **keinen gehosteten Dienst** — alle `*.fiveprotect.dev`-Adressen im Code sind
> Platzhalter und existieren nicht.
> Der Quelltext ist öffentlich einsehbar, aber nicht Open Source: siehe [Lizenz](#lizenz).

---

## Projektstatus

Das Connect-Gate funktioniert Ende-zu-Ende: Spieler verbindet → Nonce → Companion →
Attestation → Verdikt → Freigabe oder Kick. Was fehlt:

| | |
| --- | --- |
| ⚠️ **Heartbeat** | Nicht fertig. Grundgerüst, Kulanzzeit und die Abmeldung beim Beenden stehen, die Session-Überwachung ist aber noch nicht zu Ende gebaut. |
| ☐ **Web-UI / Dashboard** | Geplant. Betreiber haben aktuell nur die CLI (`provision`, `policy`, `accept-build`). |
| ☐ **Multi-Server-System** | Geplant. Das Backend ist mandantenfähig, aber ein Betreiber mit mehreren Servern wird noch nicht als eine Einheit geführt. |
| ☐ **Phasen 2–5** | TPM-Quote, vollständige Scan-Engine, Ban-Sync, Härtung — siehe [Roadmap](#roadmap). |

**Ich habe gerade keine Zeit für das Projekt.** Es liegt hier öffentlich, weil der Stand
etwas taugt und der Ansatz für andere interessant sein könnte — nicht, weil es fertig ist.

### Kein gehosteter Dienst

Die Adressen `api.fiveprotect.dev` und `dist.fiveprotect.dev` stehen als Defaults im Code
(Backend-Origin des Companions, Download-Origin des Updaters). **Sie sind nicht registriert
und antworten nicht.** Wer das ausprobieren will, betreibt das Backend selbst — siehe
[Lokal ausprobieren](#lokal-ausprobieren). Ein Rebuild ist dafür nicht nötig: eine Datei
`fiveprotect.json` neben der Exe erweitert die Origin-Liste.

---

## Was das ist

Bestehende FiveM-Anticheats sind reine Lua-Scripts. Sie laufen im selben Prozess, den sie
überwachen sollen, sehen nur was der Server ohnehin sieht, und ihre HWID-Bans überleben
keinen Spoofer.

FiveProtect ergänzt eine Kategorie, die Script-Anticheats prinzipbedingt nicht leisten können:

- **TPM-Remote-Attestation** — der Systemzustand wird in Hardware signiert. Ein Angreifer
  kann Fakten weglassen, aber keine erfinden.
- **Stabile Hardware-Identität** — der TPM-Attestation-Key ist nicht exportierbar und
  überlebt eine Neuinstallation des Betriebssystems. Ein Ban kostet damit Hardware, nicht
  einen Spoofer-Klick.
- **Environment-Härtung statt Signaturjagd** — sind HVCI, Secure Boot und die
  Treiber-Blocklist aktiv, ist die gefährliche Hälfte der Angriffsvektoren zu, statt dass man
  ihr hinterherläuft.

Zwei Entwurfsentscheidungen prägen alles Weitere:

**Der Companion urteilt nicht.** Er misst und meldet Rohfakten. Ob daraus `allow` oder `deny`
wird, entscheidet ausschließlich das Backend
([ADR 0004](docs/architecture/adr/0004-server-side-verdicts.md)). Ein manipulierter Client kann
deshalb nicht „ich bin sauber" behaupten — er kann nur schweigen, und Schweigen bewertet der
Server.

**Kein Kernel-Treiber in v1.** Bewusst, nicht aus Bequemlichkeit — die Begründung und was das
kostet steht in [ADR 0002](docs/architecture/adr/0002-no-kernel-driver-in-v1.md).

## Wie es funktioniert

Ein Spieler verbindet sich. Was dann passiert:

```
 1  Spieler verbindet          Resource hält ihn im Deferral fest
 2  Resource → Backend         "Nonce für diese Session"       (Serverkey-authentifiziert)
 3  Backend → Resource         Nonce, 30 Sekunden gültig, versiegelt in der Datenbank
 4  Resource → Client → NUI    Nonce wandert zum Spiel-Client
 5  NUI → 127.0.0.1:528xx      Localhost-Hop an den Companion  (CEF fetch, Portsuche)
 6  Companion misst            Secure Boot · HVCI · VBS · Test-Signing · Kernel-Debugger
                               Treiber-Blocklist · IOMMU · TPM
 7  Companion → Backend        Attestation: Nonce + Rohfakten  (TLS, Origin-Pinning)
 8  Backend bewertet           Policy des Mandanten → allow / deny + Begründungstext
 9  Resource ← Backend         Verdikt wird **gezogen**, nicht vom Client entgegengenommen
10  Deferral endet             Freigabe oder Kick mit handhabbarer Ursache
```

Der entscheidende Punkt ist Schritt 9. Der Spiel-Client sieht die Attestation nie und das
Verdikt nie — er trägt nur die Nonce. Damit gibt es auf dem Client nichts, dessen Manipulation
sich lohnt.

Nach dem Verbinden läuft ein **Heartbeat**: alle 120 Sekunden, mit 90 Sekunden Kulanz. Bleibt
er aus, endet die Session. Beendet der Spieler den Companion absichtlich, meldet dieser das
beim Schließen sofort ab — sonst wäre der Unterschied zwischen „abgestürzt" und „bewusst
geschlossen" ein Fenster von dreieinhalb Minuten.

Fällt das Backend aus, gilt standardmäßig **fail-open**: Spieler kommen rein. Ein Anticheat,
das bei eigener Störung den Server leerräumt, wird abgeschaltet und schützt danach gar nichts
([ADR 0005](docs/architecture/adr/0005-fail-open-by-default.md)). Pro Mandant auf `fail-closed`
umstellbar.

### Warum der Umweg über `127.0.0.1`

Das NUI ist eine CEF-Instanz im FiveM-Prozess. Sie kann `fetch` und ohne native Erweiterung
sonst nichts — Injection ist damit ausgeschlossen. Also HTTP über Loopback statt Named Pipe
([ADR 0003](docs/architecture/adr/0003-localhost-transport-for-nui-hop.md)).

Der Companion lauscht im Bereich 52800–52899. Ein Port, der antwortet, ist noch nicht der
Companion — jeder lokale Prozess kann dort lauschen. Akzeptiert wird nur eine Antwort in der
Form der `LocalAttestAck`, sonst ginge die Nonce an ein fremdes Programm.

Umgekehrt gibt der Endpoint einem fremden Aufrufer nichts: Er nimmt ausschließlich
`POST /attest` an und antwortet ausschließlich mit einer Empfangsbestätigung. Wer ihn
anspricht, kann eine Attestation auslösen — ihr Ergebnis weder lesen noch beeinflussen.

### Was der Companion erhebt

Weil die Anwendung auf den Rechnern von Spielern läuft, hier explizit:

| Wird erhoben | Wird **nicht** erhoben |
| --- | --- |
| Zustand von Secure Boot, HVCI, VBS, Test-Signing, IOMMU, TPM | Kommandozeilen laufender Prozesse |
| Ob ein Kernel-Debugger aktiv ist | Pfade aus Benutzerverzeichnissen |
| Ob die Treiber-Blocklist aktiv ist | Dokument- oder Dateinamen |
| Prozessnamen — **gehasht**, außer sie stehen auf einer Signaturliste | Tastatureingaben, Bildschirminhalte, Browserdaten |

Nur Rohfakten, nie ein Urteil. Die Scan-Engine ist rein lesend. Details in Abschnitt 13 des
[Designdokuments](docs/design/anticheat-companion-design.md).

## Architektur

```
┌──────────────── Spieler-PC ─────────────────┐
│  Companion                                  │
│   ├─ Scan-Engine        (C++, read-only)    │
│   ├─ Attestation-Modul  (C++, TBS-API)      │
│   ├─ UI-Shell           (Rust)              │
│   └─ Localhost-Endpoint (127.0.0.1)         │
│                    ▲                        │
│                    │ NUI fetch              │
│              FiveM-Client                   │
└────────────────────┼────────────────────────┘
                     │              ▲ TLS + Origin-Pinning
                     ▼              │
          ┌─────────────────────────────────┐
          │  Backend (mandantenfähig)       │
          │   Attestation · Sessions        │
          │   Scoring · Bans · Lizenzierung │
          └────────┬───────────────┬────────┘
                   │               │
          FiveM-Resource      Dashboard
          (Deferral-Gate)     (Betreiber)
```

## Repository-Aufbau

| Pfad | Inhalt | Stack |
| --- | --- | --- |
| [`packages/protocol`](packages/protocol) | **Einzige Vertragsquelle.** 18 Nachrichten, aus denen TS-, Rust-, C++- und Lua-Artefakte generiert werden. | TypeScript |
| [`services/backend`](services/backend) | Mandantenfähiges Backend: Nonce, Attestation, Verdikt, Sessions, Heartbeat | TypeScript, Fastify, PostgreSQL |
| [`resources/fiveprotect`](resources/fiveprotect) | FiveM-Resource: Deferral-Gate, NUI-Localhost-Hop, Sanktionen | Lua |
| [`apps/companion`](apps/companion) | Companion: Localhost-Endpoint, signierter Auto-Updater, Zustandsautomat | Rust |
| [`apps/companion/native`](apps/companion/native) | Scan-Engine: rein lesende Proben, C-ABI | C++ / CMake |
| [`apps/companion/ui`](apps/companion/ui) | Companion-Oberfläche: vier Zustände, ein Fenster | HTML / CSS / JS |
| [`docs`](docs) | Produktdesign, Implementierungspläne, Architekturentscheidungen (ADRs) | Markdown |

## Schnellstart

Voraussetzungen: Node.js ≥ 22, PostgreSQL ≥ 16. Für den Companion zusätzlich Rust (stable)
und die MSVC-Buildtools; für die Scan-Engine CMake ≥ 3.25.

```bash
npm install
npm run protocol:generate      # Artefakte aus den Schemas erzeugen
npm run verify                 # Lint, Typecheck, Drift-Check und alle Tests
```

## Lokal ausprobieren

Fünf Schritte vom leeren Klon zum Spieler, der durch das Gate kommt. Voraussetzung ist eine
laufende PostgreSQL-Instanz — sonst nichts.

### 1 · Datenbank, `.env`, Migrationen und Mandant

Auf Windows erledigt das ein Skript — **in PowerShell, nicht in `cmd.exe`**:

```powershell
npm install
npm run protocol:generate
.\scripts\setup-local.ps1
```

Es fragt nichts. Es legt eine eigene PostgreSQL-Instanz in
`%LOCALAPPDATA%\FiveProtect\pgdata` an, auf Port 55432, nur auf Loopback, mit einem zufällig
erzeugten Passwort. Eine bereits installierte PostgreSQL-Instanz bleibt unangetastet — kein
Standardport, keine fremde Rolle, keine Konfiguration, die verändert wird. Danach schreibt es
`services/backend/.env` mit frischem `NONCE_SEAL_KEY`, spielt die Migrationen ein und legt
einen Mandanten an.

Der Aufruf ist wiederholbar: eine vorhandene Instanz wird gestartet, nicht neu angelegt. Nach
einem Neustart des Rechners einfach nochmal aufrufen.

Wer stattdessen seine bestehende Datenbank nutzen will:
`.\scripts\setup-local.ps1 -UseSystemPostgres -PgPort 5432` — dann wird nach dem
Superuser-Passwort gefragt.

<details>
<summary>Ohne das Skript (Linux, macOS, oder von Hand)</summary>

```bash
psql -U postgres -c "create role fiveprotect with login password 'geheim'"
psql -U postgres -c "create database fiveprotect owner fiveprotect"
psql -U postgres -d fiveprotect -c "grant all on schema public to fiveprotect"

cp services/backend/.env.example services/backend/.env
# DATABASE_URL auf die Rolle oben zeigen lassen und NONCE_SEAL_KEY setzen:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run -w @fiveprotect/backend migrate
npm run -w @fiveprotect/backend provision -- "Mein Server" --tier standard
```

</details>

`provision` gibt eine `serverId` und einen `serverKey` aus. **Der Schlüssel wird genau einmal
angezeigt** — er steht nur als Hash in der Datenbank. Geht er verloren, legst du mit
`provision` einen neuen Mandanten an.

### 2 · Backend starten

```bash
npm run -w @fiveprotect/backend dev
```

Erreichbar auf `http://127.0.0.1:8080`. `GET /health` sollte antworten.

### 3 · Resource in den FiveM-Server

Den Ordner [`resources/fiveprotect`](resources/fiveprotect) in das `resources`-Verzeichnis des
Servers kopieren, dann in die `server.cfg`:

```cfg
set fiveprotect_backend    "http://127.0.0.1:8080"
set fiveprotect_server_id  "<serverId aus provision>"
set fiveprotect_server_key "<serverKey aus provision>"

ensure fiveprotect
```

Fehlt der Schlüssel, startet die Resource nicht. Eine Resource, die ohne Zugangsdaten läuft,
würde jeden Spieler deferren und dann durchlassen — das sieht aus wie Schutz und ist keiner.
Klartext-HTTP wird nur gegen `localhost` akzeptiert; gegen einen entfernten Host verweigert
die Resource den Start, weil der Serverkey sonst unverschlüsselt über die Leitung ginge.

### 4 · Companion bauen und auf das lokale Backend zeigen lassen

```bash
cargo build --release -p fiveprotect-companion
```

Der einkompilierte Origin ist die Produktionsadresse. Für ein eigenes Backend legst du eine
`fiveprotect.json` **neben die Exe** — sie erweitert die Liste, ersetzt sie nicht:

```json
{ "allowedBackends": ["http://127.0.0.1:8080"] }
```

Also `target/release/fiveprotect.json` neben `target/release/FiveProtect.exe`.
Das Setup-Skript aus Schritt 1 schreibt diese Datei bereits, wenn die Exe schon gebaut war.

Dann starten: `target\release\FiveProtect.exe`. Das Fenster zeigt „Nicht verbunden — warte auf
FiveM", das ist der erwartete Ruhezustand.

### 5 · Verbinden

FiveM starten, auf den Server verbinden. Der Deferral hält kurz, der Companion wechselt auf
„Verbunden", und du bist drin.

### Wenn es nicht klappt

| Symptom | Ursache |
| --- | --- |
| `Der Anticheat-Dienst ist gerade nicht erreichbar` beim Verbinden | Backend läuft nicht oder `fiveprotect_backend` zeigt woanders hin. `curl http://127.0.0.1:8080/health` prüfen. |
| `ECONNREFUSED` bei `migrate` | Die Datenbank läuft nicht. `.\scripts\setup-local.ps1` erneut aufrufen — nach einem Neustart des Rechners ist der Cluster gestoppt. |
| `Passwort-Authentifizierung für Benutzer »…« fehlgeschlagen` | `createdb`/`psql` nimmt ohne `-U` den Windows-Benutzernamen als DB-Rolle, und die gibt es in PostgreSQL nicht. |
| Skript startet gar nicht | In PowerShell aufrufen, nicht in `cmd.exe`. Bei Richtlinienfehlern: `powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1`. |
| Companion bleibt auf „Nicht verbunden" | Normal, solange FiveM nicht läuft. Bleibt er es beim Verbinden, fehlt die `fiveprotect.json` neben der Exe. |
| `FiveProtect läuft nicht` im Deferral | Companion nicht gestartet, oder er lauscht auf keinem Port aus 52800–52899. |

Details je Komponente in der jeweiligen README:
[Companion](apps/companion/README.md) ·
[Resource](resources/fiveprotect/README.md) ·
[Backend](services/backend/README.md) ·
[Protokoll](packages/protocol/README.md)

## Der Protokoll-Layer ist verbindlich

Vier Komponenten in vier Sprachen driften ohne gemeinsame Vertragsquelle auseinander.
Deshalb gilt: **Schemas werden nur in [`packages/protocol/src/schemas`](packages/protocol/src/schemas)
geändert.** Generierte Artefakte werden mit committet, und die CI schlägt fehl, wenn sie nicht
mehr zu den Schemas passen (`npm run protocol:check`).

## Wie geprüft wird

Jede Zusicherung, auf die sich das Produkt stützt, hat einen Test, der sie festhält:

| Was | Wo |
| --- | --- |
| Alle vier Sprachen sind sich über jeden Payload einig | Contract-Fixtures in [`packages/protocol/fixtures`](packages/protocol/fixtures) |
| Ein Companion kann kein Urteil einschmuggeln | Negativ-Fixtures plus je ein Test in TS, Rust, C++ und Lua |
| Eine Nonce wird genau einmal eingelöst, auch bei gleichzeitigen Anfragen | Zehn parallele Attestationen gegen echtes PostgreSQL |
| Ein Mandant sieht die Daten eines anderen nicht | Integrationstests mit zwei Mandanten |
| Ein manipuliertes Update-Manifest verifiziert nicht mehr | Fünf Tests, die je ein Feld nachträglich ändern |
| Der Blockiert-Bildschirm nennt eine handhabbare Ursache | Tests gegen echtes DOM, ohne rohe Kennungen |

## Roadmap

| Phase | Inhalt | Status |
| --- | --- | :---: |
| 0 · Fundament | Repository, Protokoll-Schemas mit Generatoren, Backend-Grundgerüst, CI | ✅ |
| 1 · Gate | Companion, Localhost-Transport, Nonce-Handshake, Deferral-Gate, Session-Registry, Auto-Updater | 🚧 |
| — | *offen in Phase 1:* Heartbeat/Session-Überwachung zu Ende bauen | ⚠️ |
| 2 · Attestation | AK/EK, `ActivateCredential`, Quote-Validierung, PCR-Auswertung, Policy-Engine, Hardware-Bans | ☐ |
| 3 · Scan-Engine | Vollständige C++-Engine, Evidence-Pipeline, serverseitiges Scoring (Dry-Run) | ☐ |
| 4 · Netzwerk | Netzwerkweiter Ban-Sync, **Web-UI/Dashboard**, **Multi-Server je Betreiber**, Appeal-Workflow, Lizenzierung | ☐ |
| 5 · Härtung | Anti-Tamper, Selbst-Challenge, Obfuskation, Code-Signing, Installer | ☐ |

## Vor dem kommerziellen Vertrieb zu klären

Aus Abschnitt 17 des Designdokuments, hier bewusst sichtbar gehalten:

1. **ToS-Anfrage an Cfx.re** zum externen, rein lesenden Companion — blockierend.
2. **Auftragsverarbeitungsvertrag** und Rechtsform, da Vertrieb an Dritte.
3. **Rechtsberatung zur DSGVO** vor dem ersten zahlenden Kunden.

## Mitwirken

[`CONTRIBUTING.md`](CONTRIBUTING.md) beschreibt Branch-Namen, Commit-Konvention und den
PR-Ablauf. Sicherheitsrelevante Funde bitte **nicht** als öffentliches Issue, sondern über
[`SECURITY.md`](SECURITY.md).

## Lizenz

**Proprietär, source-available.** Der Quelltext ist öffentlich, damit Serverbetreiber und
Spieler nachlesen können, was der Companion auf ihren Rechnern liest, bevor sie ihn starten.
Das ist keine Nutzungserlaubnis: Kopieren, Verändern, Weitergeben oder Betreiben für Dritte
braucht eine schriftliche Vereinbarung. Siehe [`LICENSE`](LICENSE).
