# 0001 — Monorepo mit generiertem Protokoll-Layer

**Status:** Angenommen · 2026-08-04

## Kontext

FiveProtect besteht aus vier Komponenten in vier Sprachen: Backend (TypeScript), Resource
(Lua), Companion-Shell (Rust) und Scan-Engine (C++). Alle vier tauschen dieselben
Datenstrukturen aus — Nonce, Snapshot, Quote, Verdikt.

Bei getrennten Repositories und handgeschriebenen Typen je Sprache driftet das Protokoll
auseinander. Der Fehler zeigt sich nicht beim Kompilieren, sondern zur Laufzeit auf dem
Rechner eines Spielers, der dann nicht auf den Server kommt.

## Entscheidung

Ein Monorepo. Ein Verzeichnis `packages/protocol` enthält Zod-Schemas als **einzige**
Vertragsquelle. Daraus werden erzeugt:

- TypeScript-Typen und Laufzeitvalidierung
- Rust-Structs mit `serde`
- C++-Header mit Serialisierung
- Lua-Tabellendefinitionen mit Validierungshelfern

Die generierten Artefakte werden committet. `npm run protocol:check` generiert erneut und
vergleicht; eine Abweichung lässt die CI fehlschlagen.

## Warum Zod als Quelle und nicht Protobuf oder JSON Schema

Protobuf hätte fertige Generatoren für Rust und C++, aber keinen brauchbaren für Lua, und
FiveM-Resources sprechen HTTP mit JSON. Ein binäres Format bringt hier keinen Vorteil und
erschwert das Debuggen eines Protokolls, das quer über vier Laufzeiten geht.

JSON Schema wäre neutraler, aber das Backend braucht ohnehin Laufzeitvalidierung in
TypeScript. Zod liefert Typ und Validierung aus einer Deklaration; alles andere wird
daraus generiert. Ein Generator mehr ist billiger als eine zweite Wahrheitsquelle.

## Warum generierte Artefakte committet werden

Ein Rust- oder C++-Build soll nicht Node.js voraussetzen. Committete Artefakte machen
jede Sprache eigenständig baubar; der Drift-Check in der CI verhindert, dass sie
veralten.

## Konsequenzen

**Gut:** Eine Schema-Änderung erreicht alle vier Sprachen in einem Commit. Drift wird zum
Buildfehler statt zum Produktionsfehler.

**Teuer:** Vier Generatoren müssen gepflegt werden. Ein neuer Zod-Typ, den ein Generator
nicht kennt, muss dort ergänzt werden — die Generatoren scheitern in diesem Fall
absichtlich laut statt still etwas Falsches zu erzeugen.

**Beachten:** Das Repository ist privat und trägt Erkennungslogik. Ein späterer Wechsel
zu einem öffentlichen Teil-Repository für die Resource ist möglich, aber nicht geplant.
