# Implementierungsplan — Phase 0 und Phase 1

**4. August 2026** · Grundlage:
[Designdokument](../design/anticheat-companion-design.md) ·
Umfang: Abschnitt 15, Phasen 0 und 1

---

## Was dieser Plan abdeckt

Das Designdokument beschreibt das gesamte Produkt und ist bewusst zu groß für einen
Implementierungsplan. Dieser Plan setzt **Phase 0 (Fundament)** und **Phase 1 (Gate)** um.
Phase 2 bis 5 erhalten je einen eigenen Plan.

Am Ende dieses Plans gilt: Ein Spieler kann sich nur mit einem laufenden, beim Backend
registrierten Companion verbinden. Das Verdikt entsteht ausschließlich serverseitig, das
Resource zieht es ab. Der Companion aktualisiert sich selbst.

Was am Ende dieses Plans **noch nicht** gilt: Es gibt keine TPM-Quote-Validierung (Phase 2)
und keine Cheat-Erkennung im Sinne von Abschnitt 8 (Phase 3). Der Systemzustand wird
erhoben und gespeichert, aber nur gegen die Grundanforderungen der Policy-Stufe geprüft.

## Reihenfolge und Begründung

```
0.1 Protokoll-Layer  ─┬─► 0.2 Backend-Grundgerüst ─┬─► 1.1 Gate-Endpunkte ─┬─► 1.4 Ende-zu-Ende
                      │                            │                      │
                      └─► 0.3 CI                   └─► 1.2 Resource ──────┤
                                                   └─► 1.3 Companion ─────┘
```

**Der Protokoll-Layer steht vorn**, weil vier Komponenten in vier Sprachen ohne
gemeinsame Vertragsquelle auseinanderdriften (Designdokument 4.2). Jede spätere Einheit
konsumiert generierte Artefakte statt handgeschriebener Typen.

**Das Gate steht vor der Attestation**, weil es das größte Integrationsrisiko trägt.
Scheitert der Localhost-Hop an CEF-Verhalten, CORS oder Firewall-Regeln, muss das früh
bekannt sein (Designdokument 15).

**Der Auto-Updater gehört in Phase 1**, weil er sich nicht nachrüsten lässt, ohne die
erste ausgelieferte Version aufzugeben.

---

## Phase 0 · Fundament

### 0.1 Protokoll-Layer — `packages/protocol`

**Ziel:** Eine Schema-Quelle, vier generierte Zielsprachen, Drift-Erkennung in der CI.

Schemas in `src/schemas`, jeweils mit Zod:

| Schema | Verwendung |
| --- | --- |
| `NonceRequest` / `NonceResponse` | Resource → Backend, Schritt 2 des Connect-Flows |
| `AttestationRequest` / `AttestationAck` | Companion → Backend, Schritt 6 |
| `LocalAttestCommand` / `LocalAttestAck` | NUI → Companion über 127.0.0.1, Schritt 4 |
| `SystemSnapshot` | Scan-Ergebnis, Rohfakten ohne Urteil |
| `AttestationQuote` | TPM-Quote, in Phase 1 optional, ab Phase 2 verpflichtend |
| `Verdict` | `allow` / `deny` mit Grund und Handlungsanweisung |
| `HeartbeatRequest` / `HeartbeatResponse` | Sitzungsüberwachung, alle 120 s |
| `PolicyTier`, `DenyReason`, `RequirementResult` | gemeinsame Aufzählungen |

Generatoren in `src/generators`, Ausgabe nach `generated/`:

- `typescript` — re-exportierte Typen und Laufzeitvalidierung (direkt aus Zod)
- `rust` — `serde`-Structs mit `#[serde(rename_all = "camelCase")]`
- `cpp` — Header mit Structs plus `to_json`/`from_json`
- `lua` — Tabellendefinitionen mit Validierungshelfern

**Drift-Erkennung:** `npm run protocol:check` generiert in ein temporäres Verzeichnis und
vergleicht byteweise mit `generated/`. Abweichung → Exit-Code 1.

**Tests:** Roundtrip über gemeinsame Fixtures in `fixtures/`. Jede Fixture wird von allen
vier Zielsprachen gelesen, serialisiert und muss wieder gleich sein. Zusätzlich
Negativfälle: fehlende Pflichtfelder, falsche Typen, unbekannte Enum-Werte.

**Fertig, wenn:** `npm run protocol:check` ist grün, alle vier Sprachen lesen die Fixtures,
und ein absichtlich verändertes Schema lässt die CI fehlschlagen.

### 0.2 Backend-Grundgerüst — `services/backend`

**Ziel:** Mandantenfähiges Fastify-Backend auf PostgreSQL, ohne Fachlogik.

- Migrationen als nummerierte SQL-Dateien, vorwärtsgerichtet, mit Ledger-Tabelle.
- Datenmodell nach Designdokument 11, für Phase 1 auf die tragenden Entitäten begrenzt:
  `tenants`, `game_servers`, `player_identities`, `attestation_sessions`,
  `system_snapshots`, `companion_installations`.
- Mandantentrennung: Jede Tabelle mit Mandantenbezug trägt `tenant_id`; jeder
  Repository-Zugriff nimmt die `tenant_id` als erstes Argument. Kein Zugriffspfad ohne.
- Authentifizierung: Das Resource authentifiziert sich mit einem Server-Schlüssel; nur
  dessen Hash liegt in der Datenbank. Der Companion authentifiziert sich nicht — er ist
  unvertrauenswürdig und liefert nur Fakten gegen eine gültige Nonce.
- Strukturierte Logs mit `tenantId` und `sessionId`, ohne personenbezogene Nutzlast.

**Fertig, wenn:** Migrationen laufen von leer durch, ein Health-Endpoint antwortet, und ein
Integrationstest belegt, dass ein Mandant die Daten eines anderen nicht lesen kann.

### 0.3 CI — `.github/workflows`

Vier Jobs, alle als Pflichtprüfung für den Merge nach `main`:

| Job | Inhalt |
| --- | --- |
| `Lint & Typecheck` | ESLint, `tsc --noEmit`, Prettier |
| `Protokoll-Drift` | `protocol:generate` und Vergleich gegen `generated/` |
| `Backend` | Vitest gegen PostgreSQL-Service-Container |
| `FiveM-Resource (Lua)` | Lua-Testrunner |
| `Companion` | `cargo clippy -D warnings`, `cargo test`, CMake-Build der Scan-Engine |

Zusätzlich CodeQL für JavaScript/TypeScript und Dependabot für npm, Cargo und Actions.

---

## Phase 1 · Gate

### 1.1 Gate-Endpunkte im Backend

Setzt den Connect-Flow aus Designdokument 5.1 um.

| Endpunkt | Aufrufer | Verhalten |
| --- | --- | --- |
| `POST /v1/sessions/nonce` | Resource | Erzeugt eine Nonce, 30 s gültig, einmalig einlösbar. Bindet sie an `tenantId`, `serverId`, Spieler-Identifikatoren und die Spiel-IP. |
| `POST /v1/attest` | Companion | Nimmt Snapshot und optionale Quote an, löst die Nonce ein, bewertet gegen die Policy-Stufe, schreibt das Verdikt. |
| `POST /v1/sessions/verdict` | Resource | Long-Poll, maximal 20 s. Liefert `allow` oder `deny` mit Grund. |
| `POST /v1/sessions/heartbeat` | Companion | Verlängert die Sitzung. |
| `GET /v1/sessions/:id/liveness` | Resource | Meldet, ob der Heartbeat innerhalb der Frist lag. |

> **Abweichung von der ersten Fassung dieses Plans:** Das Verdikt kam ursprünglich per
> `GET /v1/sessions/:nonce/verdict`. Eine Nonce im Pfad landet in Zugriffs-, Proxy- und
> Fehlerprotokollen, und für ihre 30 Sekunden ist sie ein Bearer-Secret. Sie steht deshalb
> im Anfragekörper. Die Session-ID darf im Pfad bleiben: sie bezeichnet einen Datensatz und
> berechtigt zu nichts.

**Nonce-Einlösung ist atomar.** Das Einlösen erfolgt als bedingtes `UPDATE … WHERE
consumed_at IS NULL RETURNING`, damit ein paralleler zweiter Versuch garantiert leer
zurückkommt. Ein Test mit gleichzeitigen Anfragen belegt das.

**Relay-Gegenmaßnahmen** nach Designdokument 5.4:
- Vergleich der öffentlichen IP der Attestation mit der vom Resource gemeldeten Spiel-IP.
- Prüfung des vom Companion gemeldeten FiveM-Prozessnachweises (PID, Startzeit).
- 30-Sekunden-Fenster der Nonce.

**Degradation** nach Designdokument 5.5: `fail-open` als Standard je Mandant,
`fail-closed` konfigurierbar. Der Fail-Modus liegt in `tenants`, nicht im Code.

**Fertig, wenn:** Der Ablauf aus 5.1 läuft im Integrationstest von der Nonce bis zum
Verdikt durch, Nonce-Wiederverwendung wird abgelehnt, IP-Abweichung erzeugt `deny`, und
ein Backend-Ausfall führt je nach Fail-Modus zu `allow` oder `deny`.

### 1.2 FiveM-Resource — `resources/fiveprotect`

- `playerConnecting` mit `deferrals.defer()`, Nonce vom Backend holen, an den Client
  reichen, Verdikt abziehen, `deferrals.done()` oder Kick mit lesbarem Grund.
- NUI-Skript versucht die Ports 52800–52899 der Reihe nach mit kurzem Timeout.
- Heartbeat-Überwachung: alle 120 s, Kulanzzeit 90 s mit sichtbarer Warnung, dann Kick.
- Kick-Gründe sind Klartext für den Spieler, nicht Fehlercodes.
- Konfiguration in `config.lua`, Server-Schlüssel per Convar, nicht im Klartext im Repo.

**Fertig, wenn:** Der Lua-Testrunner deckt Zustandsübergänge des Gates ab und ein
manueller Test gegen einen laufenden FiveM-Server lässt einen Spieler nur mit laufendem
Companion durch.

### 1.3 Companion — `apps/companion`

Aufbau nach Designdokument 4.3, harte Isolationsgrenzen:

| Einheit | Kennt | Kennt nicht |
| --- | --- | --- |
| `fiveprotect-scan` (C++) | Systemzustand | Netzwerk, Backend |
| `fiveprotect-core` (Rust) | Protokoll, HTTP, Konfiguration | UI |
| `fiveprotect-updater` (Rust) | Signaturprüfung, Dateiaustausch | Bewertungslogik |
| Tauri-Shell | Zustandsübergänge, Rendering | Sicherheitslogik |

**Localhost-Endpoint** nach Designdokument 5.3: Bindung an `127.0.0.1` im Bereich
52800–52899, gewählter Port nach `HKCU\Software\FiveProtect\Port`,
`Access-Control-Allow-Origin` auf den `nui://`-Ursprung. Ausschließlich `POST /attest`,
Antwort ist nur eine Empfangsbestätigung — es werden keine Daten ausgeliefert.

**Scan-Engine Phase 1** — nur die Proben, die die Policy-Grundanforderungen belegen:
Test-Signing, Kernel-Debugging, Secure Boot, HVCI, TPM-Präsenz und der
FiveM-Prozessnachweis. Die Prüfungen aus Abschnitt 8 folgen in Phase 3.

**Auto-Updater:** Manifest mit Ed25519-Signatur, öffentlicher Schlüssel fest im Binary,
gestufter Rollout über einen Kanal im Manifest, Rollback durch Beibehalten der
Vorgängerversion. Ein Update ohne gültige Signatur wird nicht angefasst.

**Oberfläche** nach Designdokument 12: vier Zustände, ein Fenster, keine erfundenen
Prozentwerte. Der Blockiert-Bildschirm nennt die Ursache konkret und bietet einen
Diagnose-Export.

**Fertig, wenn:** `cargo test` und der CMake-Build sind grün, der Localhost-Endpoint
antwortet nur auf `POST /attest`, und ein Update mit manipulierter Signatur wird
abgelehnt.

### 1.4 Ende-zu-Ende

Ein Integrationstest, der den vollständigen Ablauf gegen ein laufendes Backend fährt:
Nonce anfordern, lokal attestieren, Verdikt abziehen, Heartbeat halten, Heartbeat
aussetzen und den Kick beobachten.

---

## Was bewusst offen bleibt

| Offen | Bis |
| --- | --- |
| TPM-Quote wird angenommen, aber nicht validiert | Phase 2 |
| Keine Erkennungen aus Designdokument 8 | Phase 3 |
| Keine Bans, kein Dashboard, keine Lizenzprüfung | Phase 4 |
| Keine Obfuskation, kein Code-Signing, kein Installer | Phase 5 |
| VM-Testmatrix | Phase 2, wie im Designdokument vorgesehen |

Diese Lücken sind im Code als `TODO(phase-N)` markiert, damit sie auffindbar bleiben.

## Blockierende Klärungen

Aus Designdokument 17. Sie blockieren den kommerziellen Vertrieb, nicht die Entwicklung:

1. **ToS-Anfrage an Cfx.re** zum externen, rein lesenden Companion.
2. **Auftragsverarbeitungsvertrag** und Rechtsform.
3. **Rechtsberatung zur DSGVO.**

Der Prototyp des Localhost-Hops (Punkt 3 in Abschnitt 17) ist mit Schritt 1.2 und 1.3
Teil dieses Plans und damit nicht mehr vorgelagert.
