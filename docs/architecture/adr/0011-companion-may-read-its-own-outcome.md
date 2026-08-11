# ADR 0011 — Der Companion darf sein eigenes Ergebnis lesen

**Status:** Angenommen, lockert ADR 0004
**Datum:** 2026-08-04

## Kontext

ADR 0004 legt fest, dass Urteile ausschließlich serverseitig entstehen und der
Companion nie erfährt, wie seine Meldung bewertet wurde. Die Begründung: ein
Companion, der sein Ergebnis lesen kann, ist ein lokales Orakel, an dem ein
Angreifer Modifikationen durchprobieren kann, bis eine durchkommt.

Beim ersten Lauf gegen einen echten Server hat sich gezeigt, was diese Regel in
der Praxis anrichtet. Der Spieler sieht im Companion-Fenster **„Bereit"** und
gleichzeitig im Verbindungsdialog von FiveM **„Verbindung fehlgeschlagen — die
Speicherintegrität ist abgeschaltet"**. Zwei Fenster nebeneinander, die sich
widersprechen, und das falsche ist unseres.

Entscheidend ist dabei: die Begründung und der Behebungstext stehen dem Spieler
ohnehin schon vor Augen. Die Resource zeigt sie im Deferral an, weil
Designdokument 12.2 genau das verlangt — den konkreten Grund zu nennen ist der
Unterschied zwischen einem Support-Ticket und keinem. Die Geheimhaltung gegenüber
dem Companion war also nie eine echte Geheimhaltung. Sie hat den Angreifer nichts
gekostet und den ehrlichen Spieler ein Fenster, das ihn anlügt.

## Entscheidung

Der Companion darf über `POST /v1/companion/outcome` das Urteil zu **genau der
Sitzung** abfragen, für die er selbst attestiert hat.

Die Grenzen bleiben eng:

- **Nur die eigene Sitzung.** Die Sitzungs-ID muss der Aufrufer bereits besitzen,
  und er besitzt sie nur, weil er für sie attestiert hat.
- **Nur von derselben Adresse.** Kam die Attestierung von einer anderen Adresse
  als die Abfrage, antwortet das Backend so, als gäbe es die Sitzung nicht.
- **Kein Vorher.** Das Urteil existiert erst, nachdem der Snapshot bewertet
  wurde. Es gibt keinen Weg, vorab zu fragen, ob eine Konfiguration bestehen
  würde — jede Antwort kostet eine echte Attestierung mit einer echten Nonce,
  die ein Server ausgestellt hat.

Was sich **nicht** ändert: das Urteil entsteht weiterhin ausschließlich im
Backend, aus dem Snapshot und der Policy des Mandanten. Nichts, was der Companion
sendet, wird als Urteil behandelt, und der Localhost-Endpunkt gibt weiterhin
nichts als eine Bestätigung zurück (ADR 0003). Ein lokaler Prozess, der nicht
attestiert hat, erfährt nach wie vor nichts.

## Konsequenzen

Das Companion-Fenster zeigt bei einer Ablehnung dieselbe Begründung und denselben
Behebungstext wie der Verbindungsdialog, dazu die Anforderungsliste **in der
Bewertung des Servers** statt in der eigenen Messung — eine Zeile, die der
Companion als „nicht erfüllt" liest, kann auf diesem Server `skipped` sein, und
sie dort als Problem zu zeigen schickt den Spieler etwas reparieren, das niemand
verlangt hat.

Der Preis ist real und soll benannt sein: der Rückkanal für einen Angreifer wird
bequemer. Er war vorher schon vorhanden — über den Verbindungsversuch, der
dieselbe Begründung liefert — aber er kostete einen Verbindungsversuch gegen
einen echten Server, der ihn protokolliert und ratenbegrenzt. Jetzt kostet er
eine Attestierung gegen eine Nonce, die ebenfalls von einem echten Server kommt.
Die Größenordnung ändert sich nicht, die Bequemlichkeit schon.

Sollte sich das als Problem erweisen, ist der Ausweg nicht, den Text wieder zu
verstecken — er steht im Verbindungsdialog —, sondern die Ratenbegrenzung pro
Spieleridentität, die Phase 4 ohnehin für den Betreiberbericht braucht.

## Verworfene Alternativen

**Nur „nicht bestanden" ohne Grund anzeigen.** Vermeidet nichts: der Grund steht
im Verbindungsdialog. Es macht das Companion-Fenster nur zu einer zweiten,
schlechteren Quelle.

**Die Resource den Text an den Companion durchreichen lassen.** Genau der Weg,
den es während des Deferrals nicht gibt (ADR 0010), und er würde eine Aussage
des Spielclients zur Grundlage der Anzeige machen.

**Bei „Bereit" bleiben und den Widerspruch hinnehmen.** Die Variante, die im Test
stand. Ein Fenster, das „Bereit" behauptet, während der Server ablehnt, kostet
genau die Support-Tickets, die Designdokument 12.2 vermeiden will.
