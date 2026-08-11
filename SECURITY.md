# Sicherheitsrichtlinie

## Schwachstellen melden

**Bitte keine öffentlichen Issues für Sicherheitslücken.**

Meldungen bitte über die private [Security-Advisory-Funktion von
GitHub](https://github.com/coazy/FiveProtect/security/advisories/new). Enthalten sein
sollten:

- betroffene Komponente und Version bzw. Commit
- Reproduktionsschritte oder Proof of Concept
- vermutete Auswirkung

Rückmeldung innerhalb von 72 Stunden, Einschätzung innerhalb von 7 Tagen.

## Umfang

Im Umfang:

- Umgehung des Connect-Gates (Attestation, Nonce, Verdikt)
- Fälschen oder Wiedereinspielen einer Attestation
- Mandantenübergreifender Datenzugriff im Backend
- Rechteausweitung durch den Companion oder den Updater
- Angriffe auf den Localhost-Endpoint durch andere lokale Anwendungen

Nicht im Umfang:

- Umgehungen, die vollständige Kontrolle über den Spieler-PC voraussetzen und in
  [ADR 0004](docs/architecture/adr/0004-server-side-verdicts.md) sowie Abschnitt 5.4 des
  Designdokuments bereits dokumentiert getragen werden
- Denial of Service durch Volumenlast
- Findings aus automatisierten Scannern ohne belegte Auswirkung

## Bekannte, bewusst getragene Restrisiken

| Risiko | Warum getragen |
| --- | --- |
| Relay-Angriff mit zwei Maschinen hinter derselben öffentlichen IP und gefälschtem Prozessnachweis | Aufwand hoch, Restrisiko dokumentiert; serverautoritative Erkennung greift weiter (Designdokument 5.4) |
| Mainboard-Wechsel erzeugt neue Hardware-Identität | Ban-Umgehung wird teuer, nicht unmöglich (Designdokument 6.2) |
| `fail-open` bei Backend-Ausfall | Standardwert, pro Mandant auf `fail-closed` umstellbar (Designdokument 5.5) |

## Umgang mit Companion-Daten

Der Companion überträgt ausschließlich Rohfakten, niemals ein Urteil. Prozessnamen werden
gehasht übertragen, sofern sie nicht auf einer Signaturliste stehen. Es werden keine
Kommandozeilen, keine Pfade aus Benutzerverzeichnissen und keine Dokumentnamen erhoben.
Details in Abschnitt 13 des Designdokuments.
