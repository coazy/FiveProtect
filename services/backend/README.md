# @fiveprotect/backend

Mandantenfähiges Backend für das Connect-Gate. Gibt Nonces aus, nimmt Attestationen
entgegen, bewertet sie gegen die Policy-Stufe des Mandanten und hält Sitzungen am Leben.

> **Die einzige Stelle im System, die `allow` oder `deny` entscheidet.**
> Kein anderer Bestandteil erzeugt ein Urteil, und nichts, was ein Client sendet, wird als
> eines behandelt — [ADR 0004](../../docs/architecture/adr/0004-server-side-verdicts.md).

## Lokal starten

```bash
cp services/backend/.env.example services/backend/.env
createdb fiveprotect
npm run -w @fiveprotect/backend migrate
npm run -w @fiveprotect/backend dev
```

Einen Mandanten anlegen — der Server-Schlüssel wird genau einmal angezeigt:

```bash
npm run -w @fiveprotect/backend provision -- "Nordstadt Roleplay" --tier standard
```

## Endpunkte

| Endpunkt | Aufrufer | Authentifizierung |
| --- | --- | --- |
| `POST /v1/sessions/nonce` | Resource | Server-Schlüssel |
| `POST /v1/sessions/verdict` | Resource | Server-Schlüssel, Long-Poll bis 20 s |
| `GET /v1/sessions/:id/liveness` | Resource | Server-Schlüssel |
| `POST /v1/attest` | Companion | keine, an die Nonce gebunden |
| `POST /v1/sessions/heartbeat` | Companion | keine, an die Session-ID gebunden |
| `GET /health`, `GET /ready` | Betrieb | keine |

**Warum die Companion-Endpunkte keine Authentifizierung haben:** Der Companion läuft auf
einem Rechner, den der Angreifer kontrolliert. Jedes Geheimnis, das er trägt, hat der
Angreifer auch. Was eine Anfrage an eine Sitzung bindet, ist die Nonce — einmalig,
30 Sekunden gültig — und die Session-ID, die nichts weiter erlaubt, als die eigene Sitzung
am Leben zu halten.

**Warum das Verdikt per POST kommt und die Nonce nicht im Pfad steht:** Eine Nonce in einer
URL landet in Zugriffs-, Proxy- und Fehlerprotokollen. Für ihre 30 Sekunden ist sie ein
Bearer-Secret.

## Mandantentrennung

Der Mandant wird **immer** aus dem Server-Schlüssel abgeleitet, nie aus dem Anfragekörper.
Andernfalls könnte ein abgeflossener Schlüssel eines Kunden auf die Daten eines anderen
gerichtet werden — der schädlichste Einzelfehler, den ein mandantenfähiger Dienst haben
kann. Jede Repository-Funktion mit Mandantenbezug nimmt die `tenantId` als Argument; es gibt
keinen Zugriffspfad ohne.

## Was hier bewusst gehasht liegt

| Wert | Warum |
| --- | --- |
| Server-Schlüssel | Ein Datenbank-Dump darf niemandem einen funktionierenden Schlüssel in die Hand geben. |
| Nonce | Sie ist in der Übertragung ein Bearer-Secret; nur ihr Digest wird gespeichert, damit ein Dump nicht gegen ein laufendes Gate wiedereingespielt werden kann. |

SHA-256 ohne Arbeitsfaktor ist hier richtig und wäre für ein Passwort falsch: beide Werte
sind 32 Byte maschinell erzeugter Zufall, es gibt kein Wörterbuch und damit nichts, was ein
langsamer Hash erkaufen würde.

## Tests

```bash
npm run -w @fiveprotect/backend test
```

Unit-Tests laufen immer. Die Integrationstests brauchen ein echtes PostgreSQL und
überspringen sich ohne `TEST_DATABASE_URL` — sichtbar als „skipped", nicht still als
bestanden:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/fiveprotect_test \
  npm run -w @fiveprotect/backend test
```

Kein In-Memory-Ersatz: Die beiden wichtigsten Zusicherungen — dass ein bedingtes `UPDATE`
gleichzeitige Nonce-Einlösungen arbitriert und dass die Mandantentrennung hält — sind
Eigenschaften der Datenbank. Ein Fake würde nur belegen, dass der Fake mit sich selbst
übereinstimmt.

Die CI stellt einen PostgreSQL-Container bereit und prüft zusätzlich, dass die
Integrationstests tatsächlich gelaufen sind — eine übersprungene Suite gilt sonst als grün.

## Degradation

`fail_open` ist der Standardwert je Mandant
([ADR 0005](../../docs/architecture/adr/0005-fail-open-by-default.md)). Eine so zugelassene
Sitzung wird als `failOpen: true` markiert und bleibt damit im Nachhinein erkennbar. Ein
stilles `fail_open` wäre nicht zulässig.
