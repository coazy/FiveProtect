# 0005 — `fail-open` als Standardverhalten bei Backend-Ausfall

**Status:** Angenommen · 2026-08-04 · Grundlage: Designdokument 5.5

## Kontext

Ist das Backend nicht erreichbar, kann das Resource kein Verdikt abziehen. Es muss
trotzdem entscheiden, ob der Spieler verbinden darf.

`fail-closed` leert bei einem Ausfall den Server des Kunden. `fail-open` öffnet ein
Zeitfenster ohne Companion-Prüfung.

## Entscheidung

**Standardwert ist `fail-open`.** Spieler werden durchgelassen, der Vorfall wird
protokolliert und der Betreiber alarmiert. Der Fail-Modus liegt als Feld am `Tenant` in
der Datenbank; Betreiber mit höherem Schutzbedarf stellen im Dashboard auf
`fail-closed`.

## Begründung

Ein Ausfall, der den Server leert, kostet den Betreiber mehr als ein kurzes Zeitfenster
ohne Companion-Prüfung — und die serverautoritative Erkennung im Resource läuft in dieser
Zeit unverändert weiter. Der Schutz fällt also nicht aus, er wird dünner.

Der zweite Grund ist Vertrieb: Ein Anticheat, das bei der eigenen Störung den Kunden vom
Netz nimmt, wird nach dem ersten Vorfall gekündigt.

Die Entscheidung ist bewusst konfigurierbar statt fest verdrahtet. Sie hängt vom
Schutzbedarf des Betreibers ab und ist damit seine Entscheidung, nicht unsere.

## Konsequenzen

**Gut:** Eine Störung im Backend legt den Kundenserver nicht lahm.

**Teuer:** Ein Angreifer, der einen Ausfall herbeiführen kann, gewinnt ein Zeitfenster.
Daraus folgen zwei Pflichten: Der Ausfall muss *sichtbar* sein (Alarm an den Betreiber,
Eintrag in der Sitzungshistorie), und die Dauer im `fail-open` muss auswertbar bleiben,
damit im Nachhinein erkennbar ist, wer in diesem Fenster verbunden hat.

**Nicht zulässig:** `fail-open` still zu tun. Jede unter `fail-open` zugelassene Sitzung
wird als solche markiert.
