# fiveprotect — FiveM-Resource

Das Connect-Gate. Hält den verbindenden Spieler in einem Deferral, holt eine Nonce vom
Backend, reicht sie über NUI an den Companion auf `127.0.0.1` und **zieht** das Verdikt vom
Backend ab.

> Ablauf: Designdokument 5.1 · Localhost-Transport:
> [ADR 0003](../../docs/architecture/adr/0003-localhost-transport-for-nui-hop.md)

## Einrichten

`server.cfg`:

```cfg
set fiveprotect_backend    "https://api.fiveprotect.dev"
set fiveprotect_server_id  "<UUID aus provision>"
set fiveprotect_server_key "<Schlüssel aus provision, wird einmal angezeigt>"

ensure fiveprotect
```

Optional:

| Convar | Standard | Wirkung |
| --- | --- | --- |
| `fiveprotect_fail_open` | `1` | Verhalten bei unerreichbarem Backend ([ADR 0005](../../docs/architecture/adr/0005-fail-open-by-default.md)) |
| `fiveprotect_verdict_timeout` | `25` | Sekunden, die auf das Verdikt gewartet wird — muss über dem Long-Poll-Fenster des Backends liegen |
| `fiveprotect_liveness_interval` | `30` | Sekunden zwischen zwei Liveness-Prüfungen |
| `fiveprotect_verbose` | `0` | Jede Gate-Entscheidung in die Serverkonsole |

**Der Schlüssel gehört nicht ins Repository.** Er wird aus einer Convar gelesen und niemals
protokolliert. Fehlt er, startet die Resource nicht — eine Resource, die ohne Zugangsdaten
läuft, würde jeden Spieler deferren und dann durchlassen. Das sieht aus wie Schutz und ist
keiner.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `server/gate.lua` | Nonce anfordern, Verdikt abziehen, Kick-Text bestimmen — rein genug für Tests |
| `server/liveness.lua` | Heartbeat-Überwachung mit Kulanzzeit und sichtbarer Warnung |
| `server/main.lua` | Anbindung an `playerConnecting` und `playerDropped` |
| `server/http.lua` | Dünne Hülle um `PerformHttpRequest`, mit Zeitlimit |
| `client/main.lua` | Reicht die Nonce an das NUI weiter, sonst nichts |
| `nui/transport.js` | Der Localhost-Hop: Portsuche im Bereich 52800–52899 |
| `shared/protocol.lua` | **Generiert.** Nicht bearbeiten — siehe unten |

## `shared/protocol.lua` ist generiert

Eine FiveM-Resource wird als abgeschlossenes Verzeichnis geladen und kann nicht in
`packages/protocol` hineingreifen. Der Generator schreibt das Lua-Modul deshalb zusätzlich
hierher, und der Drift-Check vergleicht beide Kopien: eine von Hand bearbeitete Datei lässt
die CI genauso scheitern wie eine veraltete.

```bash
npm run protocol:generate
```

## Der Localhost-Hop

Das NUI ist eine CEF-Instanz. Sie kann `fetch`, und ohne native Erweiterung im
FiveM-Prozess kann sie nichts anderes — und Injection ist ausgeschlossen (Designdokument 3).
Deshalb HTTP statt Named Pipe.

Die Suche probiert zuerst den zuletzt erfolgreichen Port aus dem `localStorage`, danach den
gesamten Bereich parallel. Sequentiell wären hundert Versuche zu je 600 ms länger als die
30 Sekunden der Nonce; parallel gehen die Anfragen an Loopback und kosten nichts.

Ein Port, der antwortet, ist noch nicht der Companion: jeder lokale Prozess kann dort
lauschen. Akzeptiert wird nur eine Antwort in der Form der `LocalAttestAck` — sonst ginge
die Nonce an ein fremdes Programm.

## Was der Client nie erfährt

Der Spielclient sieht die Attestation nicht und das Verdikt auch nicht. Er trägt nur die
Nonce zum Companion. Damit gibt es nichts, was zu manipulieren sich lohnt (Designdokument
5.2), und der Rückmeldekanal `fiveprotect:result` ist ausdrücklich unverbindlich — er existiert,
damit der Deferral „FiveProtect läuft nicht" sagen kann, statt den Spieler das Zeitlimit
aussitzen zu lassen.

## Tests

```bash
lua tools/lua/run-all.lua              # Gate, Kick-Texte, Liveness
npm run -w @fiveprotect/resource test      # Portsuche im NUI
```

Die Lua-Suites laden die Server-Skripte in eine nachgebildete FiveM-Laufzeit
(`tools/lua/testsupport/fivem.lua`). Getestet wird damit das Verhalten der Resource, nicht
das der Engine.
