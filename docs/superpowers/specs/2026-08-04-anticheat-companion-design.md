# FiveProtect — Anticheat-Companion für FiveM

**Design-Dokument** · 4. August 2026 · Status: zur Review

---

## 1. Zweck und Zielbild

FiveProtect ist ein Anticheat für FiveM-Server, das aus zwei Hälften besteht: einer
serverautoritativen Erkennung im FiveM-Resource und einer verpflichtenden
Companion-Anwendung auf dem Spieler-PC. Der Companion prüft vor dem Verbindungsaufbau
den Zustand des Systems und meldet ihn kryptografisch beglaubigt an ein zentrales
Backend.

Das Produkt wird an FiveM-Serverbetreiber verkauft. Die Architektur ist von Beginn an
mandantenfähig; der geteilte Ban- und Telemetriebestand über alle Kunden hinweg ist der
eigentliche Wettbewerbsvorteil gegenüber den bestehenden reinen Script-Anticheats
(WaveShield, FiveGuard, Fiveuxe, Raven).

Der Unterschied zum Wettbewerb liegt nicht in mehr Detections, sondern in einer
Kategorie, die dort niemand anbietet: **echte TPM-Remote-Attestation**. Sie liefert
zwei Dinge, die kein Script-Anticheat leisten kann — einen nicht fälschbaren
Systemzustand und eine Hardware-Identität, die HWID-Spoofer nicht ändern können.

## 2. Leitprinzipien

1. **Der Companion ist ein Sensor, kein Richter.** Er liefert Rohfakten, das Backend
   urteilt. Ein manipulierter Client kann kein „sauber" behaupten — er kann nur Fakten
   weglassen, und Fehlen ist selbst ein Signal.
2. **Attestation schlägt Detection.** Nicht Cheats suchen, sondern einen Systemzustand
   erzwingen, in dem sie nicht laden. Skaliert ohne permanentes Nachziehen gegen jede
   neue Cheat-Version.
3. **Nicht in FiveM injizieren.** Der Companion liest ausschließlich von außen. Das
   vermeidet Konflikte mit dem Anticheat von Cfx.re, reduziert die ToS-Angriffsfläche
   und schließt eine ganze Klasse eigener Fehler aus.
4. **Die serverautoritative Erkennung bleibt das Fundament.** Der Companion ist eine
   zusätzliche Schicht, kein Ersatz. Was der Server selbst beobachtet, kann kein Client
   manipulieren.

## 3. Nicht-Ziele für Version 1

Bewusst ausgeschlossen, jeweils mit Begründung:

| Ausgeschlossen | Begründung |
| --- | --- |
| Eigener Kernel-Treiber | EV-Zertifikat plus Microsoft-Attestation-Signing, BSOD-Haftung, 4–6 Monate Zusatzaufwand. Die Environment-Härtung deckt die gefährlicheren Vektoren bereits ohne Treiber ab. |
| Injection in den FiveM-Prozess | ToS-Risiko und Konflikt mit dem Cfx-Anticheat. |
| Screen-Capture durch den Companion | Datenschutzrechtlich unverhältnismäßig. Spiel-Screenshots erzeugt weiterhin das Resource. |
| Forensische Datenträgeranalyse (Prefetch, AmCache, ShimCache) | Liest die vollständige Programmnutzungshistorie des Spielers aus. Für ein in der EU vertriebenes Produkt nicht verhältnismäßig. |
| Dateisystem-Scan nach Cheat-Hashes | Hohe Falsch-Positiv-Rate, durch Umbenennen umgehbar, datenschutzintensiv. |
| Machine-Learning-Erkennung | Benötigt Trainingsdaten, die erst ab Phase 4 im Netzwerk entstehen. |
| Linux- und macOS-Companion | Kein relevanter Anteil der FiveM-Spielerschaft. |

## 4. Architektur

```
┌──────────────── Spieler-PC ─────────────────┐
│  Companion                                  │
│   ├─ Scan-Engine        (C++, read-only)    │
│   ├─ Attestation-Modul  (C++, TBS-API)      │
│   ├─ UI-Shell           (Rust / Tauri)      │
│   └─ Localhost-Endpoint (127.0.0.1)         │
│                    ▲                        │
│                    │ NUI fetch              │
│              FiveM-Client                   │
└────────────────────┼────────────────────────┘
                     │              ▲ TLS + Certificate-Pinning
                     ▼              │
          ┌─────────────────────────────────┐
          │  Backend (mandantenfähig)       │
          │   Attestation · Sessions        │
          │   Scoring · Bans · Lizenzierung │
          └────────┬───────────────┬────────┘
                   │               │
          FiveM-Resource      Dashboard
          (Deferral-Gate)     (Betreiber)
```

### 4.1 Komponenten

| Komponente | Stack | Verantwortung | Abhängigkeiten |
| --- | --- | --- | --- |
| **Companion** | C++ Core, Rust/Tauri Shell | Systemzustand messen, TPM-Quote erzeugen, an Backend melden | Backend |
| **Backend** | TypeScript, PostgreSQL | Attestation validieren, Scoring, Bans, Mandanten, Lizenzen | PostgreSQL |
| **Resource** | Lua | Connect-Gate, serverautoritative Detections, Sanktionen | Backend |
| **Dashboard** | Next.js | Betreiberoberfläche: Evidence, Bans, Policy, Appeals | Backend |
| **Protocol** | Zod-Schemas → TS/Rust/C++ | Eine verbindliche Vertragsquelle für alle vier Komponenten | — |

### 4.2 Protokoll-Layer zuerst

Vier Komponenten in drei Sprachen driften ohne gemeinsame Vertragsquelle
zwangsläufig auseinander. Deshalb wird zuerst ein Schema-Verzeichnis angelegt, aus dem
generiert werden:

- TypeScript-Typen und Laufzeitvalidierung für Backend und Dashboard
- Rust-Structs mit `serde` für die Companion-Shell
- C++-Header und Serialisierung für die Scan-Engine
- Lua-Tabellendefinitionen mit Validierungshelfern für das Resource

Der Generator läuft in der CI. Eine Schema-Änderung ohne regenerierte Artefakte lässt
den Build fehlschlagen.

### 4.3 Isolationsgrenzen

Jede Einheit hat eine Aufgabe und eine dokumentierte Schnittstelle:

- **Scan-Engine** kennt weder Backend noch Netzwerk. Eingabe: Systemzustand.
  Ausgabe: ein `SystemSnapshot`-Objekt. Vollständig ohne Netzwerk testbar.
- **Attestation-Modul** kennt nur TPM und Nonce. Ausgabe: `AttestationQuote`.
  Enthält keine Bewertungslogik.
- **UI-Shell** kennt nur Zustandsübergänge und rendert. Keine Sicherheitslogik.
- **Backend-Attestation-Service** ist die einzige Stelle, die über `allow` oder `deny`
  entscheidet.

## 5. Connect-Flow

### 5.1 Ablauf

```
1. Spieler verbindet          → Resource: deferrals.defer()
2. Resource → Backend         : requestNonce(tenantId, serverId, license)
                              ← Nonce N, gültig 30 s, einmalig
3. Resource → Client          : N
4. Client (NUI) → 127.0.0.1   : POST /attest { nonce: N }
5. Companion                  : Scan-Snapshot + TPM-Quote über N
6. Companion → Backend        : POST /attest { N, quote, snapshot, buildHash }
7. Backend                    : Quote validieren, Policy prüfen, Verdikt speichern
8. Resource → Backend         : pollVerdict(N)   (Long-Poll, max. 20 s)
                              ← allow | deny(reason, remediation)
9. Resource                   : deferrals.done()  oder  Kick mit lesbarem Grund
```

### 5.2 Begründung der Konstruktion

- **Die Nonce stammt vom Server**, nicht vom Companion. Andernfalls ist das
  Wiedereinspielen einer älteren gültigen Antwort trivial.
- **Der Companion kommuniziert direkt mit dem Backend**, nicht über den Spielclient.
  Der Client sieht die Attestation nie und kann sie daher nicht verändern.
- **Der Localhost-Hop belegt Ko-Lokation** von Companion und Spielclient auf derselben
  Maschine.
- **Das Verdikt zieht das Resource ab**, statt es entgegenzunehmen. Damit gibt es keinen
  eingehenden Pfad, den ein Angreifer bespielen könnte.

### 5.3 Localhost-Transport

Der Companion bindet auf `127.0.0.1` an einen Port aus einem festen Bereich
(52800–52899) und schreibt den gewählten Port in einen Registry-Wert unter
`HKCU\Software\FiveProtect\Port`. Das NUI-Skript versucht die Ports der Reihe nach. Der
Companion setzt `Access-Control-Allow-Origin` auf den `nui://`-Ursprung des Resources.

Der Endpoint akzeptiert ausschließlich `POST /attest` mit einer Nonce und liefert
ausschließlich eine Empfangsbestätigung. Es werden keine Daten über diesen Weg
ausgeliefert; damit ist er auch dann unkritisch, wenn eine andere lokale Anwendung ihn
anspricht.

### 5.4 Relay-Angriff

Ein Angreifer kann den Companion auf einem sauberen Rechner B laufen lassen und die
Nonce vom verseuchten Rechner A dorthin weiterleiten. Gegenmaßnahmen:

- Das Backend vergleicht die öffentliche IP-Adresse der Attestation mit der IP-Adresse
  der Spielverbindung, die der FiveM-Server meldet. Abweichung → `deny`.
- Der Companion meldet PID, Startzeitpunkt und Fenster-Handle des lokal laufenden
  FiveM-Prozesses. Fehlt der Prozess → `deny`.
- Das Zeitfenster der Nonce beträgt 30 Sekunden.

Das macht den Angriff aufwendig, nicht unmöglich. Wer zwei Maschinen hinter derselben
öffentlichen IP betreibt und den Prozessnachweis fälscht, kommt durch. Dieses Restrisiko
wird bewusst getragen; dort greift die serverautoritative Erkennung.

### 5.5 Verfügbarkeit und Degradation

**Backend nicht erreichbar:** Das Verhalten ist pro Mandant konfigurierbar.
Standardwert ist `fail-open` — Spieler werden durchgelassen, der Vorfall wird
protokolliert und der Betreiber alarmiert. Begründung: Ein Ausfall, der den Server
leert, kostet den Betreiber mehr als ein kurzes Zeitfenster ohne Companion-Prüfung, und
die serverautoritative Erkennung läuft in dieser Zeit unverändert weiter. Betreiber mit
höherem Schutzbedarf können auf `fail-closed` stellen.

**Companion beendet sich während der Sitzung:** Alle 120 Sekunden erwartet das Backend
einen Heartbeat. Bleibt er aus, folgt eine Kulanzzeit von 90 Sekunden mit sichtbarer
Warnung im Spiel, danach ein Kick. Damit überstehen Companion-Neustarts und kurze
Netzwerkaussetzer die Sitzung, ein absichtliches Beenden jedoch nicht.

**Attestation zeitüberschritten:** Nach 20 Sekunden ohne Antwort erhält der Spieler eine
Kick-Meldung mit konkreter Ursache und Hinweis auf den Companion.

## 6. TPM-Attestation

Der Kern der Differenzierung. Vollständig im Usermode über die TBS-API umsetzbar.

### 6.1 Ablauf

1. Der Companion erzeugt bei der Erstregistrierung einen **Attestation Key (AK)** im
   TPM und liest das **Endorsement Key Certificate (EK-Cert)** aus.
2. Das Backend validiert die EK-Zertifikatskette gegen die hinterlegten Root-CAs der
   TPM-Hersteller (Infineon, STMicroelectronics, Nuvoton, Intel PTT, AMD fTPM).
3. Das Backend stellt einen **`ActivateCredential`-Challenge**. Nur ein TPM, das sowohl
   EK als auch AK besitzt, kann ihn auflösen. Damit ist bewiesen, dass der AK im selben
   physischen TPM liegt wie der zertifizierte EK.
4. Bei jedem Verbindungsaufbau liefert der Companion einen **Quote** über die
   PCR-Register 0, 1, 2, 3, 4, 7 und 11, mit der Server-Nonce als qualifizierenden
   Daten.
5. Das Backend prüft die Quote-Signatur gegen den registrierten AK und wertet PCR 7
   (Secure-Boot-Zustand) sowie das TCG-Event-Log aus.

### 6.2 Konsequenzen

**Nicht fälschbar.** Die Signatur entsteht in Hardware. Ein manipulierter Companion kann
sie nicht erzeugen — er kann nur nicht antworten, und das ist ein `deny`.

**Belastbare Hardware-Bans.** Der öffentliche AK-Schlüssel ist eine stabile
Hardware-Identität. HWID-Spoofer ändern Datenträger-Seriennummern, MAC-Adressen und
SMBIOS-Felder; einen im TPM erzeugten, nicht exportierbaren Schlüssel können sie nicht
ändern. Ein Ban auf die AK-Identität überdauert Neuinstallationen des Betriebssystems.

**Grenze:** Ein Mainboard- oder CPU-Wechsel erzeugt eine neue Identität. Das ist
akzeptiert — es macht Ban-Umgehung teuer statt unmöglich.

## 7. Environment-Policy

Ein verkauftes Produkt kann nicht ab dem ersten Tag maximale Härtung erzwingen. Drei
Stufen, die der Betreiber wählt:

| Anforderung | Relaxed | Standard | Strict |
| --- | :---: | :---: | :---: |
| Companion läuft und ist attestiert | ✔ | ✔ | ✔ |
| Test-Signing und Kernel-Debugging deaktiviert | ✔ | ✔ | ✔ |
| Prüfung auf angreifbare Treiber | warnen | blocken | blocken |
| Secure Boot aktiv | — | ✔ | ✔ |
| TPM 2.0 mit gültiger Attestation | — | ✔ | ✔ |
| **Speicherintegrität (HVCI)** | — | ✔ | ✔ |
| Microsoft-Blocklist für angreifbare Treiber aktiv | — | ✔ | ✔ |
| IOMMU / Kernel-DMA-Schutz | — | warnen | ✔ |

### 7.1 Warum HVCI verpflichtend in Standard steht

Die Speicherintegrität verlagert die Code-Signatur-Prüfung des Kernels in den
Hypervisor, außerhalb der Reichweite des Kernels selbst. Damit kann unsignierter Code im
Kernel nicht mehr ausgeführt werden, selbst wenn ein Angreifer bereits Kernel-Rechte
erlangt hat.

Das unterbindet den mit Abstand häufigsten Weg von FiveM-Cheats nach Ring 0: einen
legitim signierten, aber verwundbaren Treiber laden und über dessen Lücke eigenen
unsignierten Code einschleusen. Der zweite Schritt scheitert unter HVCI. Aus demselben
Grund ist „Speicherintegrität deaktivieren" bei nahezu jeder Cheat-Anleitung der erste
Schritt. HVCI hat damit das beste Verhältnis von Schutzwirkung zu Umsetzungsaufwand im
gesamten Katalog.

### 7.2 Was Härtung leistet und was nicht

| Angriffsvektor | Environment-Härtung | Eigener Kernel-Treiber nötig |
| --- | --- | --- |
| Unsignierter Kernel-Cheat | verhindert (HVCI) | — |
| Ausnutzung angreifbarer Treiber | verhindert (HVCI + Blocklist) | — |
| Bootkit / EFI-Manipulation | verhindert (Secure Boot + PCR-Prüfung) | — |
| DMA-Karte (PCIe) | verhindert (IOMMU) | — |
| Usermode-Injection in FiveM | nur erkennbar | zum Blockieren nötig |
| Externer Speicherleser ohne Injection | nur erkennbar | zum Blockieren nötig |

Die obere, gefährlichere Hälfte wird ohne eigenen Treiber vollständig abgedeckt. Die
untere Hälfte bleibt Erkennung — was in der Praxis ausreicht, weil ein Usermode-Cheat
ohne Kernel-Unterstützung fast immer ein Prozess-Handle benötigt und damit von der
Handle-Enumeration erfasst wird.

### 7.3 Umstellungshilfe für Betreiber

Vor der Aktivierung einer Stufe erzeugt das Dashboard einen Vorschau-Bericht: Wie viele
der in den letzten 14 Tagen aktiven Spieler würden die neue Stufe nicht erfüllen,
aufgeschlüsselt nach Ursache. Ohne diese Vorschau schaltet ein Betreiber Strict ein und
sperrt einen erheblichen Teil seiner Spielerschaft aus.

### 7.4 Falsch-Positiv-Realität bei HVCI

Windows deaktiviert die Speicherintegrität automatisch, sobald ein inkompatibler Treiber
installiert ist — häufig ältere Audio-Interfaces, RGB-Steuerungssoftware und einzelne
VPN-Clients. Betroffene Spieler haben nie gecheatet. Der Blockiert-Bildschirm muss
deshalb den blockierenden Treiber namentlich nennen (Windows stellt diese Information
bereit) und nicht nur zum Einschalten auffordern.

## 8. Scan-Engine

Ausschließlich lesende Standard-Win32- und NT-APIs. Keine Injection, kein Treiber.

Nach Ertrag je Aufwand geordnet:

1. **Handle-Enumeration** — `NtQuerySystemInformation(SystemExtendedHandleInformation)`.
   Welche Prozesse halten ein Handle auf den Spielprozess mit `PROCESS_VM_READ`,
   `PROCESS_VM_WRITE` oder `PROCESS_VM_OPERATION`. Erfasst praktisch jeden externen
   Cheat ohne Kernel-Unterstützung.
2. **Thread-Origin-Prüfung** — Threads im Spielprozess, deren Startadresse in Speicher
   vom Typ `MEM_PRIVATE` mit Ausführungsrecht liegt statt in einem `MEM_IMAGE`-Modul.
   Das ist manuell gemappter Code. Stärkste Einzelerkennung im Usermode.
3. **Modul-Integrität** — Hash der `.text`-Sektionen geladener Module gegen die Dateien
   auf dem Datenträger. Findet Inline-Hooks und Patches.
4. **Treiberliste** — geladene Kernel-Module gegen die Liste bekannter angreifbarer
   Treiber (loldrivers.io), synchronisiert vom Backend.
5. **Synthetische Mauseingaben** — Low-Level-Maus-Hook, Auswertung des
   `LLMHF_INJECTED`-Flags. Erfasst Software-Aimbots, die über `SendInput` oder
   `mouse_event` zielen. Geringer Aufwand, hohe Präzision, wenige Falsch-Positive.
6. **Unbekannter Hypervisor** — CPUID-Vendor-String und Timing der VM-Exits. Geprüft
   wird auf einen *unbekannten* Hypervisor; Hyper-V und VBS melden ebenfalls einen
   Hypervisor und dürfen nicht anschlagen.
7. **Handle auf `\Device\PhysicalMemory`** — eindeutiges Signal, vernachlässigbarer
   Aufwand.
8. **Overlay-Fenster** — Fenster mit den Attributen layered, topmost und transparent
   über dem Spielfenster. Erfasst externe ESP-Overlays.
9. **Zertifikatsanomalien bei Treibern** — Signaturen mit widerrufenen oder
   kompromittierten Zertifikaten, Zeitstempel in der Zukunft.
10. **Artefaktsignaturen** — Prozessnamen, Fenstertitel, Named Pipes und Mutexe bekannter
    Executors. Geringster Aufwand, kürzeste Halbwertszeit, deshalb zuletzt.

### 8.1 Zu prüfende Zusatzoption

Startet der Companion den FiveM-Client selbst, kann er über
`PROCESS_CREATION_MITIGATION_POLICY_BLOCK_NON_MICROSOFT_BINARIES` das Laden fremder DLLs
unterbinden — echte Prävention im Usermode ohne Treiber. FiveM lädt jedoch eigene, nicht
von Microsoft signierte Bibliotheken, wodurch die Maßnahme den Client vermutlich
funktionsunfähig macht. **Vor Phase 3 als Wegwerf-Prototyp verifizieren**; nur bei
positivem Ergebnis in den Umfang aufnehmen.

## 9. Baseline-Drift

Über den TPM-Attestation-Key existiert eine stabile Hardware-Identität. Damit lässt sich
je Maschine eine Zustandshistorie führen.

Das entscheidende Signal: Speicherintegrität war drei Wochen aktiv und wird zwanzig
Minuten vor dem Verbindungsaufbau deaktiviert. Niemand deaktiviert HVCI versehentlich
kurz vor dem Spielen. Dieses Signal ist aussagekräftiger als jeder einzelne Scan.

Erfasst werden Zustandsübergänge von HVCI, Secure Boot, Test-Signing, IOMMU und der
Treiber-Blocklist samt Zeitstempel. Ein Übergang von aktiv nach inaktiv innerhalb von
24 Stunden vor einem Verbindungsaufbau erzeugt ein Review-Signal, keinen automatischen
Ban.

Der Aufwand ist gering, weil die Daten ohnehin erhoben werden. Ein Script-Anticheat kann
das prinzipbedingt nicht, weil ihm die stabile Identität fehlt.

## 10. Anti-Tamper

Der Companion läuft auf einem Rechner, den der Angreifer kontrolliert. Das ist eine
Rahmenbedingung, kein lösbares Problem. Die Architektur trägt sie:

- **Alle Urteile entstehen serverseitig.** Der Companion überträgt
  `{ threads: [...], handles: [...], pcrs: [...] }`, niemals `{ clean: true }`.
- **Selbst-Challenge.** Das Backend fordert stichprobenartig den Hash eines zufälligen
  64-KB-Bereichs der eigenen `.text`-Sektion ab einem zufälligen Offset an. Ein
  nachgebauter Companion scheitert daran.
- **Build-Pinning.** Nur bekannte, signierte Build-Hashes werden akzeptiert. Eine
  veraltete Version erzwingt ein Update statt ein Umgehungsfenster zu öffnen.
- **Obfuskation** (VMProtect oder Themida) ab Phase 5. Sie erhöht die Kosten des
  Reverse-Engineering, ersetzt aber keine der drei vorstehenden Maßnahmen.
- **Automatische Aktualisierung ab Phase 1.** In einem Wettlauf gegen Cheat-Entwickler
  ist die Fähigkeit, binnen Stunden einen Fix auszurollen, wichtiger als jede einzelne
  Erkennung. Signierter Updater, gestufter Rollout, Rollback-Pfad. Nicht nachrüstbar,
  ohne die erste ausgelieferte Version aufzugeben.

## 11. Datenmodell

Die tragenden Entitäten:

| Entität | Zweck | Wesentliche Felder |
| --- | --- | --- |
| `Tenant` | Kunde (Serverbetreiber) | Lizenzstatus, Policy-Stufe, Fail-Modus, Ban-Netzwerk-Teilnahme |
| `GameServer` | Einzelner FiveM-Server eines Tenants | API-Zugangsdaten, erwartete IP-Adressen |
| `HardwareIdentity` | TPM-Identität einer Maschine | AK-Public-Key, EK-Cert-Fingerprint, TPM-Hersteller, Erstsichtung |
| `PlayerIdentity` | FiveM-Identifikatoren | license, steam, discord, Verknüpfung zu Hardware-Identitäten |
| `AttestationSession` | Ein Verbindungsversuch | Nonce, Verdikt, Policy-Ergebnis je Anforderung, IP-Vergleich |
| `SystemSnapshot` | Scan-Ergebnis einer Attestation | Rohbefunde je Prüfung, Build-Hash des Companions |
| `EnvironmentBaseline` | Zustandshistorie je Hardware-Identität | Zustandsübergänge mit Zeitstempel |
| `Detection` | Bewertetes Signal | Quelle (Companion oder Resource), Schwere, Evidence-Referenz |
| `Ban` | Sanktion | Geltungsbereich (lokal oder Netzwerk), Ziel (Player oder Hardware), Ablauf, Begründung |
| `Appeal` | Einspruch | Status, Bearbeiter, Entscheidung |

Ein Ban trägt einen expliziten Geltungsbereich. Netzwerkweite Bans erfordern
Companion-Evidence oder eine manuelle Bestätigung durch den Betreiber; rein
serverseitige Heuristiken erzeugen niemals automatisch einen netzwerkweiten Ban.

## 12. Companion-Oberfläche

Ein Fenster, etwa 420 × 560 Pixel. Kein Vollbild, kein Startbildschirm.

### 12.1 Zustände

Vier, nicht mehr:

- **Nicht verbunden** — wartet auf Backend
- **Prüfung läuft** — dezente Fortschrittsanzeige ohne erfundene Prozentwerte
- **Bereit** — Statusliste, Freigabe zum Verbinden
- **Blockiert** — konkrete Ursache und Handlungsanweisung

```
┌──────────────────────────────┐
│  ●  Bereit                   │
│                              │
│  Secure Boot      aktiv      │
│  TPM 2.0          aktiv      │
│  Speicherintegr.  aktiv      │
│  Systemprüfung    bestanden  │
│                              │
│  Du kannst dem Server jetzt  │
│  beitreten.                  │
│                              │
│  ──────────────────────────  │
│  Version 1.0.0 · Protokoll   │
└──────────────────────────────┘
```

### 12.2 Der Blockiert-Bildschirm

Der wichtigste Bildschirm des Produkts. „Secure Boot ist deaktiviert" allein erzeugt ein
Support-Ticket. Dieselbe Meldung mit herstellerspezifischer Anleitung erzeugt keines.
Hier entsteht erfahrungsgemäß der Großteil des Supportaufkommens; der Bildschirm wird
entsprechend ausgearbeitet und enthält einen Diagnose-Export per Klick.

### 12.3 Gestaltung

Systemschriftart (Segoe UI Variable), neutrale Graustufen, genau eine Akzentfarbe. Keine
Verläufe, kein Glow, keine Emojis in der Oberfläche. Linksbündig, großzügige
Innenabstände, Statuszeilen als schlichte zweispaltige Liste. Hell- und Dunkelmodus
folgen der Systemeinstellung. Referenzpunkt sind die Desktop-Anwendungen von Tailscale
und 1Password, nicht Gaming-Oberflächen.

Tray-Symbol vorhanden. Autostart optional, standardmäßig deaktiviert.

## 13. Datenschutz

Das Produkt wird in der EU vertrieben und verarbeitet personenbezogene Daten auf
Endgeräten Dritter.

- Auftragsverarbeitungsvertrag zwischen Betreiber (Verantwortlicher) und FiveProtect
  (Auftragsverarbeiter)
- Einwilligung beim ersten Start des Companions, mit verständlicher Auflistung der
  erhobenen Datenarten
- Datenminimierung: Prozessnamen werden gehasht übertragen, sofern sie nicht auf einer
  Signaturliste stehen; keine Kommandozeilen, keine Dateipfade aus
  Benutzerverzeichnissen, keine Dokumentnamen
- Speicherfristen: Snapshots 30 Tage, Detections 180 Tage, Bans für die Dauer ihrer
  Gültigkeit
- Auskunfts- und Löschpfad über das Dashboard

## 14. Teststrategie

| Ebene | Vorgehen |
| --- | --- |
| Protokoll | Contract-Tests, Roundtrip-Prüfung TypeScript ↔ Rust ↔ C++ ↔ Lua |
| Backend | Unit- und Integrationstests; Attestation-Validierung gegen aufgezeichnete echte TPM-Quotes als Fixtures, plus gezielt manipulierte Negativfälle |
| Scan-Engine | Unit-Tests gegen synthetische Szenarien; Test-Harness, das einen Dummy-Prozess startet und eine bekannte DLL manuell mappt, um die Thread-Origin-Erkennung zu verifizieren |
| Resource | Bestehendes Lua-Testrunner-Muster |
| Ende-zu-Ende | VM-Matrix über die Kombinationen Secure Boot an/aus, TPM an/aus, HVCI an/aus, diskretes TPM gegen fTPM, Intel gegen AMD |
| Red-Team | Kontrollierter Test-Injector als eigenes Werkzeug, nicht ausgeliefert |

Die VM-Matrix ist keine Nebensache. Attestation-Fehler treten hardwareabhängig auf und
sind auf einer einzelnen Entwicklungsmaschine nicht auffindbar. Der Aufbau der Matrix
gehört in Phase 2.

## 15. Phasen

| Phase | Inhalt | Dauer |
| --- | --- | --- |
| **0 · Fundament** | Repository, Protokoll-Schemas mit Generatoren, mandantenfähiges Backend-Grundgerüst, CI | 2 Wochen |
| **1 · Gate** | Minimaler Companion, Localhost-Transport, Nonce-Handshake, Deferral-Gate im Resource, Session-Registry, signierter Auto-Updater | 3 Wochen |
| **2 · Attestation** | AK- und EK-Handhabung, `ActivateCredential`, Quote-Validierung, PCR-Auswertung, Policy-Engine, Hardware-Bans, Baseline-Historie, VM-Testmatrix | 5 Wochen |
| **3 · Scan-Engine** | C++-Engine mit den Prüfungen aus Abschnitt 8, Evidence-Pipeline, serverseitiges Scoring — durchgehend im Dry-Run | 5 Wochen |
| **4 · Netzwerk** | Netzwerkweiter Ban-Sync, Dashboard, Appeal-Workflow, Lizenzierung | 4 Wochen |
| **5 · Härtung** | Anti-Tamper, Selbst-Challenge, Obfuskation, Code-Signing, Installer, Datenschutzunterlagen | 4 Wochen, danach laufend |

**Begründung der Reihenfolge:** Phase 1 steht vorn, weil das Gate das größte
Integrationsrisiko trägt. Sollte der Localhost-Hop an CEF-Verhalten, CORS oder
Firewall-Regeln scheitern, muss das in Woche 3 bekannt sein und nicht in Woche 15. Der
Auto-Updater gehört ebenfalls in Phase 1, weil er sich nicht nachrüsten lässt, ohne die
erste ausgelieferte Version aufzugeben.

Bis zur Beta ist mit rund sechs Monaten zu rechnen, danach mit dauerhafter Wartung. Ein
Anticheat erreicht keinen Fertigzustand.

## 16. Risiken

| Risiko | Schwere | Umgang |
| --- | --- | --- |
| ToS-Konflikt mit Cfx.re bei externem Client | hoch | **Vor Phase 1 klären.** Das rein lesende Design minimiert das Risiko, beseitigt es aber nicht. Einzige Frage, die das Vorhaben kippen kann. |
| Relay-Angriff | hoch | IP-Bindung, Prozesspräsenz, enges Zeitfenster; Restrisiko dokumentiert getragen |
| Falsch-Positive | hoch | Dry-Run-Pflicht je Mandant, Evidence-first, Appeal-Workflow, keine automatischen Netzwerk-Bans aus Heuristiken |
| Spielerakzeptanz | hoch | Gestufte Policy, ausgearbeiteter Blockiert-Bildschirm, transparente Datenschutzerklärung |
| Supportaufkommen | mittel | Selbsthilfeanleitungen im Client, Diagnose-Export, Vorschau-Bericht für Betreiber |
| DSGVO-Verstoß | mittel | Abschnitt 13; Rechtsberatung vor kommerziellem Vertrieb |
| Hardwareabhängige Attestation-Fehler | mittel | VM-Testmatrix in Phase 2, gestufter Rollout |

## 17. Vor Phase 1 zu klären

1. **ToS-Anfrage an Cfx.re** zum externen, rein lesenden Companion. Blockierend.
2. **Rechtsform und Auftragsverarbeitungsvertrag**, da Vertrieb an Dritte.
3. **Prototyp des Localhost-Hops** aus einem FiveM-NUI heraus, um das
   Haupt-Integrationsrisiko vor dem Aufbau zu entschärfen.

---

## Umfang dieses Dokuments

Dieses Dokument beschreibt das Produkt vollständig. Es ist bewusst zu groß für einen
einzelnen Implementierungsplan. Der erste Implementierungsplan deckt **Phase 0 und
Phase 1** ab; jede weitere Phase erhält vor ihrem Beginn einen eigenen Plan auf Basis
dieses Dokuments.
