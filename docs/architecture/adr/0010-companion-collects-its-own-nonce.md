# ADR 0010 — Der Companion holt seine Nonce beim Backend ab

**Status:** Angenommen, korrigiert ADR 0003
**Datum:** 2026-08-04

## Kontext

ADR 0003 legt fest, dass der Spielclient die Nonce über einen NUI-Frame an
`127.0.0.1` weiterreicht. Das Verbindungs-Gate ist darauf aufgebaut: der Spieler
wird im Deferral gehalten, die Resource fordert eine Nonce an, schickt sie per
`TriggerClientEvent` an den Client, und der Client-Frame trägt sie zum Companion.

Beim ersten Ende-zu-Ende-Lauf gegen einen echten FiveM-Server hat sich gezeigt,
dass dieser Weg zum entscheidenden Zeitpunkt nicht existiert. FiveM startet die
Client-Resourcen erst, **nachdem** das Deferral abgeschlossen ist. Während der
Spieler im Deferral hängt, läuft auf seinem Client kein einziges Skript von uns —
es gibt niemanden, der das Event empfangen könnte. Der NUI-Hop funktioniert
genau dann, wenn der Spieler schon im Spiel ist, also genau dann nicht, wenn das
Gate ihn braucht.

Ohne Ersatz bedeutet das: jede Attestierung läuft in den Timeout. Unter
`fail_open` kommen alle Spieler ohne jede Prüfung durch, unter `fail_closed`
niemand. Beides sieht nach funktionierendem Schutz aus und ist keiner.

## Entscheidung

Der Companion holt die Nonce selbst ab. Er hält eine lange Anfrage auf
`POST /v1/companion/pending` offen; das Backend antwortet, sobald für **die
Adresse, von der die Anfrage kommt**, eine offene Sitzung existiert.

Die Absenderadresse ist das einzige Auswahlkriterium. Sie lässt sich vom Aufrufer
nicht wählen, und sie ist dieselbe Adresse, die die Relay-Prüfung ohnehin
vergleicht (Designdokument 5.4).

Drei Folgeentscheidungen:

- **Mehrdeutigkeit wird abgelehnt, nicht geraten.** Zwei Spieler hinter einer
  NAT erzeugen zwei offene Sitzungen von derselben Adresse. Das Backend
  antwortet dann mit `409 origin_ambiguous`. Eine der beiden auszuwählen hieße,
  dass der Snapshot einer sauberen Maschine die Sitzung eines Cheaters
  beantworten kann — das ist der Angriff, nicht der Randfall.
- **Die Nonce wird verschlüsselt abgelegt.** Bisher stand nur ihr Digest in der
  Datenbank, damit ein Dump nicht gegen ein laufendes Gate abspielbar ist. Da
  das Backend die Nonce nun herausgeben muss, wird sie zusätzlich mit AES-256-GCM
  unter `NONCE_SEAL_KEY` versiegelt. Der Schlüssel liegt in der Umgebung, nicht
  in der Datenbank; ein Dump allein bleibt wertlos. Beim Einlösen wird die
  Versiegelung im selben Statement gelöscht, das die Sitzung beansprucht.
- **Der Localhost-Endpunkt bleibt.** Er ist weiterhin der Weg für eine erneute
  Prüfung, während der Spieler im Spiel ist — dort laufen Client-Skripte, und
  dort funktioniert der Hop wie beschrieben.

## Konsequenzen

Der Companion braucht keinen Kontakt zum Spielclient mehr, um seine Arbeit zu
tun. Das entspricht dem, was Designdokument 5.2 ohnehin verlangt: der Companion
meldet direkt und nie über den Spielclient.

Der Preis ist eine Dauerverbindung pro laufendem Companion. Bei einem
Poll-Fenster von 25 Sekunden ist das eine Anfrage alle 25 Sekunden pro Spieler,
was gegenüber dem Verdikt-Long-Poll, den die Resource ohnehin hält, nicht ins
Gewicht fällt.

Offen bleibt der NAT-Fall. Zwei gleichzeitig verbindende Spieler hinter einer
Adresse werden derzeit beide abgewiesen, statt dass einer falsch bedient wird —
das ist die sichere Richtung, aber keine Lösung. Der geplante Ausweg ist eine
Deferral-Karte mit einem `fiveprotect://`-Link, über den der Spielclient die Nonce
gezielt an den Companion auf seiner eigenen Maschine übergibt. Das gehört in
Phase 2, wo der Companion mit dem TPM-Attestation-Key ohnehin eine Identität
bekommt, an der eine Sitzung eindeutig festgemacht werden kann.

## Verworfene Alternativen

**Nonce über die Deferral-Karte mit Klick.** Funktioniert ohne Client-Skripte
und löst den NAT-Fall, kostet aber bei jedem Verbinden einen Klick. Als
alleiniger Weg zu viel Reibung; als Ausweg für den mehrdeutigen Fall vorgemerkt.

**Spieler erst hereinlassen, dann prüfen und ggf. kicken.** Der NUI-Hop
funktioniert, sobald der Spieler im Spiel ist. Das öffnet aber ein Fenster, in
dem ein ungeprüfter Client auf dem Server ist, und widerspricht der Zusage, dass
das Gate vor dem Beitritt entscheidet.

**Nonce im Klartext speichern.** Einfacher, gibt aber die Eigenschaft auf, für
die `nonce_hash` überhaupt existiert.
