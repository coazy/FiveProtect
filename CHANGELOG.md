# Changelog

Alle nennenswerten Änderungen an FiveProtect. Format nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

## [0.1.0] — 2026-08-04

Erste Version. Deckt Phase 0 (Fundament) und Phase 1 (Gate) des Designdokuments ab.

Am Ende dieser Version gilt: Ein Spieler kommt nur mit laufendem, beim Backend registriertem
Companion auf den Server. Das Verdikt entsteht ausschließlich serverseitig, das Resource
zieht es ab, und der Companion kann sich selbst aktualisieren.

### Hinzugefügt

**Protokoll-Layer** (`@fiveprotect/protocol`) — 18 Nachrichten, 8 Aufzählungen und 7 Konstanten
aus einer Quelle, generiert nach TypeScript, Rust, C++ und Lua. Alle vier Sprachen prüfen
Typen *und* Constraints und lesen dieselben Contract-Fixtures. Drift zwischen Schema und
generiertem Artefakt lässt die CI fehlschlagen.

**Backend** (`@fiveprotect/backend`) — mandantenfähiges Fastify auf PostgreSQL: Nonce-Ausgabe,
Attestation-Annahme, Long-Poll-Verdikt, Session-Registry und Heartbeat-Überwachung.
Policy-Stufe und Fail-Modus je Mandant. Server-Schlüssel und Nonce liegen nur als Digest in
der Datenbank.

**FiveM-Resource** (`resources/fiveprotect`) — Deferral-Gate am Connect, NUI-Hop zum Companion
auf 127.0.0.1, Heartbeat-Überwachung mit Kulanzzeit und lesbaren Kick-Gründen.

**Companion** (`apps/companion`)

- C++-Scan-Engine mit den rein lesenden Phase-1-Proben: Secure Boot, Test-Signing,
  Kernel-Debugger, HVCI, VBS, Treiber-Sperrliste, Kernel-DMA-Schutz, TPM-Präsenz und
  FiveM-Prozessnachweis. C-ABI zum Rust-Kern.
- Rust-Kern mit Localhost-Endpoint (Portbereich 52800–52899, Registry-Hinweis unter
  `HKCU\Software\FiveProtect\Port`), signiertem Ed25519-Auto-Updater mit gestuftem Rollout und
  dem Zustandsautomaten der Oberfläche.
- Oberfläche mit vier Zuständen, 420 × 560 Pixel, dunkel mit Mint-Akzent und Manrope.

**CI** — Lint, Typecheck, Formatprüfung, Protokoll-Drift und Tests aller vier Sprachen,
Backend-Integrationstests gegen einen PostgreSQL-Container, Scan-Engine-Build auf einem
Windows-Runner, Abhängigkeits-Audit für npm und Cargo.

### Bewusst offen

| Offen | Bis |
| --- | --- |
| TPM-Quote wird angenommen, aber nicht validiert | Phase 2 |
| Keine Erkennungen aus Designdokument 8 | Phase 3 |
| `vulnerable_drivers_absent` blockiert noch nicht (`PHASE_1_OVERRIDES`) | Phase 3 |
| Keine Bans, kein Dashboard, keine Lizenzprüfung | Phase 4 |
| Keine Obfuskation, kein Code-Signing, kein Installer | Phase 5 |
| VM-Testmatrix | Phase 2 |

### Abweichungen vom Designdokument

- **Abschnitt 12.3** — die Oberfläche nutzt Manrope statt der Systemschrift und legt sich
  auf Dunkel fest, statt der Systemeinstellung zu folgen
  ([ADR 0009](docs/architecture/adr/0009-dark-only-interface-with-mint-accent.md)).
- **Abschnitt 4.2** — Vertragsquelle ist eine Zwischendarstellung, aus der auch die
  Zod-Schemas generiert werden, statt Reflexion über Zod-Interna
  ([ADR 0008](docs/architecture/adr/0008-schema-ir-instead-of-zod-reflection.md)).

### Nicht verfügbar auf dem aktuellen GitHub-Plan

Branch-Rulesets und CodeQL brauchen GitHub Pro beziehungsweise Advanced Security. Der
Workflow wird über Squash-only-Merges und Konvention durchgesetzt, die Codeanalyse durch ein
Abhängigkeits-Audit ersetzt. Beides in
[ADR 0007](docs/architecture/adr/0007-github-workflow-and-branch-protection.md) festgehalten
statt stillschweigend hingenommen.

[Unreleased]: https://github.com/coazy/FiveProtect/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/coazy/FiveProtect/releases/tag/v0.1.0
