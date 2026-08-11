# @fiveprotect/protocol

Die einzige Vertragsquelle für jede Nachricht, die FiveProtect überträgt. Vier Komponenten in
vier Sprachen lesen dieselben Definitionen — Backend (TypeScript), Companion (Rust),
Scan-Engine (C++) und FiveM-Resource (Lua).

> Hintergrund: [ADR 0001](../../docs/architecture/adr/0001-monorepo-with-generated-protocol.md)
> und [ADR 0008](../../docs/architecture/adr/0008-schema-ir-instead-of-zod-reflection.md)

## Die eine Regel

**Geändert wird ausschließlich in [`src/schemas`](src/schemas).** Alles unter
[`generated/`](generated) wird erzeugt; eine Bearbeitung dort ist beim nächsten
`npm run protocol:generate` weg und lässt bis dahin die CI fehlschlagen.

```bash
npm run protocol:generate   # Artefakte erzeugen
npm run protocol:check      # scheitert bei Drift zwischen Schema und Artefakt
```

## Ablauf

```
src/schemas/*.ts   ──►  IR  ──┬─► generated/typescript/protocol.ts   Zod-Schemas + Typen
  Deklarationen               ├─► generated/rust/protocol.rs         serde + validate()
                              ├─► generated/cpp/fiveprotect_protocol.hpp Structs + JSON
                              └─► generated/lua/protocol.lua         Validatoren
```

Die Artefakte werden committet, damit Rust, C++ und Lua ohne Node.js gebaut werden können.
Der Drift-Check ist das, was sie davon abhält zu veralten.

## Verzeichnisse

| Pfad | Inhalt |
| --- | --- |
| [`src/ir.ts`](src/ir.ts) | Zwischendarstellung und Registry-Prüfung |
| [`src/schemas/`](src/schemas) | Die Deklarationen. Ladereihenfolge ist Deklarationsreihenfolge. |
| [`src/generators/`](src/generators) | Ein Generator je Zielsprache |
| [`fixtures/`](fixtures) | Gemeinsame Contract-Fixtures, von allen vier Sprachen gelesen |
| [`cpp/`](cpp) | Handgeschriebener JSON-Werttyp und die C++-Contract-Tests |
| [`rust/`](rust) | Crate, das das generierte Modul einbindet, plus Contract-Tests |
| [`lua/`](lua) | Lua-Contract-Tests |

## Warum die Reihenfolge wichtig ist

C++ erzeugt keine Vorwärtsdeklarationen. Ein Struct muss deklariert sein, bevor etwas
darauf verweist. `validateRegistry` erzwingt das und nennt das verletzende Feld — sonst
tauchte der Fehler als Compilerfehler in einer generierten Datei auf.

## Contract-Tests

Alle vier Sprachen lesen [`fixtures/index.json`](fixtures/index.json) und müssen sich über
jeden Eintrag einig sein. Ein Payload, den das Backend annimmt, die Resource aber ablehnt,
ist genau die Drift, gegen die dieser Layer existiert.

```bash
npm run -w @fiveprotect/protocol test                  # TypeScript
cargo test -p fiveprotect-protocol                     # Rust
lua tools/lua/run-all.lua                          # Lua
cmake -S cpp -B cpp/build && cmake --build cpp/build --config Release && ctest --test-dir cpp/build -C Release
```

Die Fixtures unter `invalid/` sind nicht Beiwerk. Jede von ihnen belegt eine Zusicherung —
etwa dass ein Snapshot mit einem Feld `clean` in allen vier Sprachen abgelehnt wird, weil
ein Companion niemals ein Urteil sendet
([ADR 0004](../../docs/architecture/adr/0004-server-side-verdicts.md)).

## Ein Feld hinzufügen

1. Feld in der passenden Datei unter `src/schemas` deklarieren, mit Beschreibung — sie
   landet als Kommentar in allen vier Sprachen.
2. `npm run protocol:generate`
3. Fixture ergänzen oder erweitern, bei Bedarf einen Negativfall unter `invalid/`.
4. Tests aller vier Sprachen laufen lassen.
5. Generierte Artefakte mit committen.

Braucht das Feld ein Konstrukt, das die IR nicht kennt (Union, Map, Rekursion), scheitert
die Generierung mit `UnsupportedTypeError`. Das ist Absicht: erst die IR erweitern und
allen vier Generatoren beibringen — oder das Protokoll einfacher schneiden.
