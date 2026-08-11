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
und antworten nicht.** Wer das ausprobieren will, betreibt das Backend selbst und trägt seine
eigene URL ein — für den Companion heißt das, die Origin-Liste in
`apps/companion/crates/fiveprotect-companion/src/settings.rs` anzupassen und neu zu bauen,
weil sie bewusst im Build festgeschrieben ist und nicht vom Client kommen darf.

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
[Designdokuments](docs/superpowers/specs/2026-08-04-anticheat-companion-design.md).

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

Backend lokal starten:

```bash
cp services/backend/.env.example services/backend/.env
createdb fiveprotect
npm run -w @fiveprotect/backend migrate
npm run -w @fiveprotect/backend dev
```

Einen Mandanten anlegen — der Schlüssel wird genau einmal angezeigt:

```bash
npm run -w @fiveprotect/backend provision -- "Nordstadt Roleplay" --tier standard
```

In der `server.cfg` des FiveM-Servers:

```cfg
set fiveprotect_backend    "https://dein-backend.example"   # kein gehosteter Dienst, s. o.
set fiveprotect_server_id  "<UUID aus provision>"
set fiveprotect_server_key "<Schlüssel aus provision>"

ensure fiveprotect
```

Fehlt der Schlüssel, startet die Resource nicht. Eine Resource, die ohne Zugangsdaten läuft,
würde jeden Spieler deferren und dann durchlassen — das sieht aus wie Schutz und ist keiner.

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
