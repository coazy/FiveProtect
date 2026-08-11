# fiveprotect-core

Der Teil des Companions, der etwas entscheiden darf — und das ist absichtlich wenig.

| Modul | Kennt | Kennt nicht |
| --- | --- | --- |
| `local` | den Localhost-Endpoint und seinen Vertrag | Backend, Scan |
| `updater` | Signaturen und Dateiaustausch | Policy, Bewertung |
| `state` | welchen von vier Zuständen das Fenster zeigt | warum |

```bash
cargo test -p fiveprotect-core
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt -p fiveprotect-core --check
```

## Was hier nicht steht

Kein Feld heißt `clean`, `passed` oder `verdict`. Der Companion überträgt Rohfakten und nie
ein Urteil ([ADR 0004](../../../../docs/architecture/adr/0004-server-side-verdicts.md)). Ein
Test vergleicht die Felderliste der Empfangsbestätigung, damit niemand später eines ergänzt,
das ein Ergebnis verrät.

## Die Zusicherungen, auf die es ankommt

**Der Endpoint nimmt genau eine Sache an.** `POST /attest`, sonst nichts. Sechs Kombinationen
aus Methode und Pfad sind als Ablehnung festgehalten — jede davon probiert ein feindlicher
lokaler Prozess früher oder später.

**Die Backend-URL wird geprüft, nicht geglaubt.** Sie kommt vom Spielclient und ist damit
unvertrauenswürdig. Verglichen wird der exakte Origin, nicht ein Präfix: sonst käme
`https://api.fiveprotect.dev.angreifer.example` durch und der Systemzustand ginge an einen
fremden Server. Ein Test hält genau diesen Fall fest.

**Ready ist nur aus Checking erreichbar.** Und Checking nur, wenn eine Nonce ankam. Damit
kann keine Folge lokaler Ereignisse ein „Bereit" fälschen. Eine erneut eintreffende
Bestätigung lässt den Zustand in Ruhe — Idempotenz, kein Übergang.

**Ein Update braucht zwei gültige Prüfungen.** Signatur des Manifests *und* Hash der
geladenen Datei, immer, in dieser Reihenfolge. Eine gültige Signatur über ein Manifest, das
auf eine ausgetauschte Datei zeigt, würde sonst die ausgetauschte Datei installieren. Fünf
Tests bearbeiten je ein Feld eines signierten Manifests nachträglich und erwarten, dass
keines mehr verifiziert.

**Kein Downgrade.** So führt ein Angreifer eine behobene Schwäche wieder ein.

## Warum ein eigener base64-Decoder

Der Updater muss für die Lebensdauer jedes ausgelieferten Builds funktionieren. Eine
Abhängigkeit weniger auf genau diesem Pfad ist es wert — ein Updater, der sein eigenes
Manifest nicht mehr parsen kann, kann sich auch nicht selbst reparieren.
