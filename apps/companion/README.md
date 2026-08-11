# FiveProtect Companion

Die Anwendung auf dem Spieler-PC. Misst den Systemzustand, meldet ihn an das Backend und
zeigt dem Spieler, woran er ist.

> **Der Companion ist ein Sensor, kein Richter.**
> Er überträgt Rohfakten und nie ein Urteil
> ([ADR 0004](../../docs/architecture/adr/0004-server-side-verdicts.md)). Ein manipulierter
> Client kann kein „sauber" behaupten — er kann nur Fakten weglassen, und Fehlen bewertet
> das Backend.

## Aufbau

| Einheit | Sprache | Kennt | Kennt nicht |
| --- | --- | --- | --- |
| [`native/`](native) | C++ | Systemzustand | Netzwerk, Backend |
| [`crates/fiveprotect-core/`](crates/fiveprotect-core) | Rust | Protokoll, Localhost-Endpoint, Updater | Oberfläche |
| [`ui/`](ui) | HTML, CSS, JS | vier Zustände und wie man sie rendert | warum |

Die Grenzen sind Absicht (Designdokument 4.3). Die Scan-Engine ist ohne Netzwerk testbar,
die Oberfläche ohne Rust, und der Kern ohne beides.

## Bauen

```bash
# Scan-Engine
cmake -S apps/companion/native -B build-scan
cmake --build build-scan --config Release
ctest --test-dir build-scan -C Release --output-on-failure

# Kern
cargo test -p fiveprotect-core

# Oberfläche
npm run -w @fiveprotect/companion-ui test
```

Was die Engine auf dieser Maschine sieht:

```bash
./build-scan/Release/scan_dump.exe
```

## Der Localhost-Endpoint

Bindet auf `127.0.0.1` im Bereich 52800–52899 und schreibt den gewählten Port nach
`HKCU\Software\FiveProtect\Port`. Der Registry-Wert ist ein Hinweis, kein Vertrauensanker: das
NUI probiert den Bereich ohnehin durch, weil der Wert veraltet oder weg sein kann und ein
Spieler im Deferral das nicht reparieren soll.

Angenommen wird **ausschließlich `POST /attest`**, zurück kommt **ausschließlich eine
Empfangsbestätigung**. Jeder lokale Prozess kann `127.0.0.1` ansprechen — CORS schützt
Browser, nicht nativen Code. Der Endpoint ist deshalb so gebaut, dass er einem anderen
Aufrufer nichts nützt: Er kann eine Attestation auslösen und weder ihr Ergebnis lesen noch
es beeinflussen.

Die Backend-URL kommt vom Spielclient und ist damit unvertrauenswürdig. Sie wird gegen eine
im Build hinterlegte Liste geprüft — exakter Origin-Vergleich, kein Präfix, sonst käme
`https://api.fiveprotect.dev.angreifer.example` durch.

## Der Updater

Designdokument 10 stellt ihn in Phase 1, weil er sich nicht nachrüsten lässt, ohne die erste
ausgelieferte Version aufzugeben. Im Wettlauf gegen Cheat-Entwickler ist die Fähigkeit,
binnen Stunden einen Fix auszurollen, wichtiger als jede einzelne Erkennung.

Vertrauensanker ist ein Ed25519-Schlüssel im Binary. Beide Prüfungen laufen immer und in
dieser Reihenfolge:

1. **Signatur des Manifests** — sonst könnte ein Angreifer im Netz ein eigenes ausliefern.
2. **Hash der geladenen Datei** — eine gültige Signatur über ein Manifest, das auf eine
   ausgetauschte Datei zeigt, würde sonst die ausgetauschte Datei installieren.

Dazu: kein Downgrade (so führt ein Angreifer eine behobene Schwäche wieder ein), kein
fremder Kanal, kein fremder Download-Origin, und ein gestufter Rollout, damit ein schlechtes
Update einen Teil der Spielerschaft erreicht statt alle.

## Die Oberfläche

Vier Zustände, ein Fenster, 420 × 560 Pixel. Dunkles Grau, Mint als einzige Akzentfarbe,
Manrope als woff2 im Binary — der Rechner, der den Blockiert-Bildschirm am dringendsten
lesen muss, ist oft genau der ohne Netz.

Das weicht von Abschnitt 12.3 des Designdokuments ab; festgehalten in
[ADR 0009](../../docs/architecture/adr/0009-dark-only-interface-with-mint-accent.md).

Der Blockiert-Bildschirm zeigt den Text des Backends wörtlich. Nur dort ist die Ursache
bekannt, und „Speicherintegrität ist deaktiviert" erzeugt ein Support-Ticket, während
dieselbe Meldung mit dem Namen des blockierenden Treibers keines erzeugt.

## Was hier noch nicht drin ist

| Offen | Bis |
| --- | --- |
| TPM-Quote: Attestation-Key, `ActivateCredential`, PCR-Auswertung | Phase 2 |
| Die Erkennungen aus Abschnitt 8 — Handle-Enumeration, Thread-Origin, Modul-Integrität | Phase 3 |
| Selbst-Challenge, Obfuskation, Code-Signing, Installer | Phase 5 |

Im Code als `TODO(phase-N)` markiert, damit sie auffindbar bleiben.
