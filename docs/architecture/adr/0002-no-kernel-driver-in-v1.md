# 0002 — Kein eigener Kernel-Treiber in Version 1

**Status:** Angenommen · 2026-08-04 · Grundlage: Designdokument 3 und 7.2

## Kontext

Konkurrierende Anticheats setzen auf Kernel-Treiber, um Usermode-Injection zu blockieren
statt sie nur zu erkennen. Ein eigener Treiber wäre die naheliegende Antwort.

## Entscheidung

Version 1 liefert keinen Kernel-Treiber. Stattdessen wird die Umgebung gehärtet: HVCI,
Secure Boot, IOMMU und die Microsoft-Treiber-Blocklist, durchgesetzt über die
Environment-Policy und belegt über TPM-Attestation.

## Begründung

Der Aufwand ist erheblich: EV-Zertifikat, Microsoft-Attestation-Signing, 4–6 Monate
zusätzliche Entwicklung — und eine BSOD-Haftung gegenüber zahlenden Kunden.

Der Ertrag ist gering, weil die Härtung die gefährlichere Hälfte der Vektoren bereits
vollständig abdeckt:

| Vektor | Ohne Treiber |
| --- | --- |
| Unsignierter Kernel-Cheat | verhindert (HVCI) |
| Ausnutzung angreifbarer Treiber | verhindert (HVCI + Blocklist) |
| Bootkit / EFI-Manipulation | verhindert (Secure Boot + PCR) |
| DMA-Karte (PCIe) | verhindert (IOMMU) |
| Usermode-Injection | nur erkennbar |
| Externer Speicherleser | nur erkennbar |

Die untere Hälfte bleibt Erkennung. Das reicht in der Praxis, weil ein Usermode-Cheat
ohne Kernel-Unterstützung fast immer ein Prozess-Handle auf den Spielprozess braucht und
damit von der Handle-Enumeration erfasst wird.

Ein Treiber bringt also Prävention für die Hälfte, die auch ohne ihn zuverlässig
*erkannt* wird — zum teuersten Preis im gesamten Katalog.

## Konsequenzen

**Gut:** Kein Signaturprozess, keine BSOD-Haftung, Version 1 rund ein halbes Jahr früher.

**Teuer:** Usermode-Injection wird erkannt, nicht verhindert. Ein Spieler kann eine Runde
lang cheaten, bevor die Erkennung greift.

**Wenn diese Entscheidung fällt:** Ein Treiber wird nicht nachgerüstet, ohne dass die
Erkennungsrate aus Phase 3 belegt, dass die Usermode-Erkennung unzureichend ist. Die
Zahlen dafür entstehen ab Phase 3 im Dry-Run.
