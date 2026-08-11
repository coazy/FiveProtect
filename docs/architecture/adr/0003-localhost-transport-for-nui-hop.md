# 0003 — Localhost-Transport für den NUI-Hop

**Status:** Angenommen · 2026-08-04 · Grundlage: Designdokument 5.3

## Kontext

Der Companion muss beweisen, dass er auf derselben Maschine läuft wie der Spielclient.
Andernfalls kann ein Angreifer einen sauberen Rechner attestieren lassen und mit einem
verseuchten spielen.

Kandidaten: Named Pipe, Shared Memory, Localhost-HTTP.

## Entscheidung

Localhost-HTTP. Der Companion bindet an `127.0.0.1` auf einen freien Port aus dem Bereich
**52800–52899** und schreibt den gewählten Port nach `HKCU\Software\FiveProtect\Port`. Das
NUI-Skript versucht die Ports der Reihe nach mit kurzem Timeout.

Der Endpoint akzeptiert **ausschließlich `POST /attest`** mit einer Nonce und antwortet
**ausschließlich mit einer Empfangsbestätigung**. Über diesen Weg werden keine Daten
ausgeliefert.

## Begründung

**Warum HTTP statt Named Pipe:** Das FiveM-NUI ist eine CEF-Instanz. Sie kann `fetch`,
sie kann keine Named Pipes und kein Shared Memory ohne eine native Erweiterung im
Spielprozess — und Injection in den FiveM-Prozess ist ausgeschlossen (Designdokument 3).

**Warum ein Portbereich statt eines festen Ports:** Ein fester Port kollidiert
irgendwann. Der Registry-Wert ist ein Hinweis, kein Vertrauensanker — das NUI probiert
den Bereich ohnehin durch, falls der Wert fehlt oder veraltet ist.

**Warum der Endpoint nichts ausliefert:** Jede lokale Anwendung kann `127.0.0.1`
ansprechen; CORS schützt nur Browser, nicht native Prozesse. Da der Endpoint nur eine
Nonce entgegennimmt und nichts zurückgibt, ist der Missbrauch durch eine andere lokale
Anwendung folgenlos: Sie kann eine Attestation auslösen, aber weder ihr Ergebnis lesen
noch es beeinflussen.

**Was der Hop belegt und was nicht:** Er belegt Ko-Lokation von Companion und Client. Er
belegt nicht, dass der Companion ehrlich ist — das leistet die serverseitige Bewertung
(ADR 0004).

## Konsequenzen

**Gut:** Funktioniert ohne Injection und ohne native NUI-Erweiterung.

**Teuer:** Firewall- und Sicherheitssoftware kann lokale Bindungen blockieren. Das ist
das größte Integrationsrisiko der Phase 1 und der Grund, warum das Gate vor der
Attestation gebaut wird.

**Restrisiko:** Ein Angreifer kann den Localhost-Port auf Maschine A auf Maschine B
weiterleiten. Dagegen wirken IP-Vergleich, Prozessnachweis und das 30-Sekunden-Fenster
der Nonce; das verbleibende Restrisiko wird nach Designdokument 5.4 bewusst getragen.
