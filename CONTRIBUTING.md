# Mitwirken an FiveProtect

## Grundregeln

1. **`main` ist immer auslieferbar.** Direkte Pushes auf `main` sind nicht vorgesehen;
   jede Änderung läuft über einen Pull Request mit grüner CI.
2. **Schemas zuerst.** Jede protokollrelevante Änderung beginnt in
   `packages/protocol/src/schemas`. Generierte Artefakte werden mit
   `npm run protocol:generate` erzeugt und mit committet.
3. **Der Companion urteilt nicht.** Code, der clientseitig `allow`/`deny` entscheidet,
   wird abgelehnt — siehe [ADR 0004](docs/architecture/adr/0004-server-side-verdicts.md).

## Branches

| Präfix | Zweck |
| --- | --- |
| `feat/` | Neue Funktionalität |
| `fix/` | Fehlerbehebung |
| `docs/` | Nur Dokumentation |
| `chore/` | Build, CI, Abhängigkeiten |
| `refactor/` | Umbau ohne Verhaltensänderung |

Beispiel: `feat/phase-1-connect-gate`

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), Scope ist das Paket:

```
feat(protocol): add heartbeat envelope
fix(backend): reject nonce reuse across tenants
chore(ci): cache cargo registry
```

Ein Commit = eine abgeschlossene Änderung. Kein „WIP" auf `main`.

## Pull Requests

- Titel folgt der Commit-Konvention.
- Beschreibung nutzt [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).
- CI muss grün sein: Lint, Typecheck, Protokoll-Drift, Tests aller vier Sprachen.
- Merge per **Squash**, damit die `main`-Historie eine Änderung pro Commit trägt.

## Lokale Prüfung vor dem Push

```bash
npm run lint
npm run typecheck
npm run protocol:check     # scheitert bei Drift zwischen Schema und Artefakt
npm test
```

Companion und Scan-Engine zusätzlich:

```bash
cargo test  --manifest-path apps/companion/Cargo.toml
cargo clippy --manifest-path apps/companion/Cargo.toml -- -D warnings
cmake --workflow --preset ci     # in apps/companion/native
```

## Tests

- **Protokoll:** Roundtrip-Prüfung über alle vier Zielsprachen gegen gemeinsame Fixtures.
- **Backend:** Unit-Tests ohne Datenbank, Integrationstests gegen echtes PostgreSQL.
- **Scan-Engine:** Unit-Tests gegen synthetische Szenarien, keine Netzwerkabhängigkeit.
- **Resource:** Lua-Testrunner unter `resources/fiveprotect/tests`.

Neue Erkennungen brauchen einen Negativfall — ein Szenario, das *nicht* anschlagen darf.
Falsch-Positive sind in diesem Produkt teurer als Falsch-Negative.

## Sicherheitsrelevante Änderungen

Änderungen an Attestation, Nonce-Handhabung, Lizenzprüfung oder Localhost-Transport
brauchen eine ausdrückliche Review-Freigabe und einen Hinweis im PR-Text, welche
Annahme sich ändert.
