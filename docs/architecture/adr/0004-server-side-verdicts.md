# 0004 — Urteile entstehen ausschließlich serverseitig

**Status:** Angenommen · 2026-08-04 · Grundlage: Designdokument 2 und 10

## Kontext

Der Companion läuft auf einem Rechner, den der Angreifer vollständig kontrolliert. Er
kann ihn patchen, nachbauen, unter einem Debugger fahren oder seine Antworten fälschen.
Das ist eine Rahmenbedingung, kein lösbares Problem.

## Entscheidung

Der Companion ist ein Sensor, kein Richter. Er überträgt ausschließlich Rohfakten:

```jsonc
{ "threads": [...], "handles": [...], "pcrs": [...], "secureBoot": "enabled" }
```

Niemals ein Urteil:

```jsonc
{ "clean": true }   // wird vom Backend nicht akzeptiert
```

Die einzige Stelle, die `allow` oder `deny` entscheidet, ist der Attestation-Service im
Backend. Code, der clientseitig urteilt, wird im Review abgelehnt.

## Begründung

Ein manipulierter Client kann kein „sauber" behaupten, wenn „sauber" gar kein
übertragbarer Wert ist. Er kann nur Fakten **weglassen** — und Fehlen ist selbst ein
Signal, das das Backend bewertet.

Damit verschiebt sich die Frage von „Kann der Client lügen?" (immer ja) zu „Was gewinnt
er durch Lügen?" (eine unvollständige Meldung, die auffällt).

Ergänzend, aber ausdrücklich **nicht** als Ersatz:

- **Selbst-Challenge:** Das Backend fordert stichprobenartig den Hash eines zufälligen
  64-KB-Bereichs der `.text`-Sektion des Companions ab einem zufälligen Offset an.
- **Build-Pinning:** Nur bekannte, signierte Build-Hashes werden akzeptiert.
- **TPM-Quote (ab Phase 2):** Die Signatur entsteht in Hardware und ist nicht fälschbar.

## Konsequenzen

**Gut:** Die Sicherheitseigenschaft hängt nicht an der Integrität eines Binaries auf
fremder Hardware. Ein nachgebauter Companion muss echte Fakten liefern oder auffallen.

**Teuer:** Mehr übertragene Daten und mehr Bewertungslogik im Backend. Datenminimierung
wird dadurch zur ausdrücklichen Pflicht (Designdokument 13), nicht zum Nebeneffekt.

**Für Reviews:** Ein PR, der ein Boolean wie `isClean`, `passed` oder `verdict` aus dem
Companion an das Backend sendet, verletzt dieses ADR — unabhängig davon, wie das Feld
heißt.
