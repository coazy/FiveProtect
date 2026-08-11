# 0006 — TPM-Attestation-Key als Hardware-Identität

**Status:** Angenommen · 2026-08-04 · Grundlage: Designdokument 6 und 9

## Kontext

Bans müssen einen Neuaufsetzer des Betriebssystems überleben. Die übliche HWID besteht
aus Datenträger-Seriennummern, MAC-Adressen und SMBIOS-Feldern — alles Werte, die ein
Spoofer in Minuten ändert.

## Entscheidung

Die Hardware-Identität ist der öffentliche Teil eines **Attestation Key (AK)**, der im
TPM erzeugt wird und es nicht verlässt. Die Bindung an echte Hardware wird beim ersten
Kontakt bewiesen:

1. Companion erzeugt den AK im TPM und liest das EK-Zertifikat aus.
2. Backend validiert die EK-Kette gegen die Root-CAs der TPM-Hersteller
   (Infineon, STMicroelectronics, Nuvoton, Intel PTT, AMD fTPM).
3. Backend stellt eine `ActivateCredential`-Challenge. Nur ein TPM, das EK *und* AK
   besitzt, kann sie auflösen.

Ab dann signiert der AK bei jedem Verbindungsaufbau einen Quote über PCR 0, 1, 2, 3, 4, 7
und 11 mit der Server-Nonce als qualifizierenden Daten.

## Begründung

Der Schlüssel ist nicht exportierbar. Ein Spoofer kann Seriennummern umschreiben, aber
keinen privaten Schlüssel aus einem TPM holen. Ein Ban auf die AK-Identität überdauert
damit eine Neuinstallation.

Der zweite Ertrag ist die **Baseline-Drift** (Designdokument 9): Mit einer stabilen
Identität lässt sich eine Zustandshistorie je Maschine führen. Das aussagekräftigste
Einzelsignal des gesamten Produkts entsteht daraus — HVCI war drei Wochen aktiv und wird
zwanzig Minuten vor dem Verbindungsaufbau deaktiviert. Niemand tut das versehentlich.

Ein Script-Anticheat kann das prinzipbedingt nicht, weil ihm die stabile Identität fehlt.

## Konsequenzen

**Gut:** Belastbare Hardware-Bans und eine Zustandshistorie, die ohne Zusatzaufwand
entsteht, weil die Daten ohnehin erhoben werden.

**Grenze:** Ein Mainboard- oder CPU-Wechsel erzeugt eine neue Identität. Das ist
akzeptiert — es macht Ban-Umgehung teuer statt unmöglich.

**Ausschluss:** Spieler ohne TPM 2.0 können die Policy-Stufen Standard und Strict nicht
erfüllen. Das ist beabsichtigt, aber der Grund, warum es die Stufe Relaxed gibt und warum
das Dashboard vor jeder Umstellung einen Vorschau-Bericht erzeugt (Designdokument 7.3).

**Datenschutz:** Der AK ist ein dauerhaftes Gerätemerkmal. Er wird nur zur Erkennung von
Ban-Umgehung verwendet, unterliegt den Fristen aus Designdokument 13 und wird nie an
andere Mandanten im Klartext weitergegeben.
