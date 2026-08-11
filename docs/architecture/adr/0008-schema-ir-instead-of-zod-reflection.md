# 0008 — Schema-IR statt Reflexion über Zod

**Status:** Angenommen · 2026-08-04 · Verfeinert ADR 0001

## Kontext

ADR 0001 legt fest: eine Vertragsquelle, vier generierte Zielsprachen. Es nennt Zod als
diese Quelle. Bei der Umsetzung stellte sich die Frage, *wie* die Generatoren an die
Schemastruktur kommen.

Der naheliegende Weg ist Reflexion über die internen Felder von Zod (`_def`, `typeName`,
`innerType`). Der ist aus drei Gründen schlecht:

1. Diese Felder sind kein zugesagtes API. Zwischen Zod 3 und 4 haben sie sich geändert;
   ein Minor-Update kann alle vier Generatoren gleichzeitig brechen.
2. Es gibt keine Stelle, an der Zusatzinformationen hängen können, die kein Zod-Konzept
   sind — Feldbeschreibungen für die generierten Kommentare, die Deklarationsreihenfolge
   für C++ ohne Vorwärtsdeklarationen, Kennzeichnung von Aufzählungswerten.
3. Ein Konstrukt, das ein Generator nicht kennt, fällt bei Reflexion still durch. Genau
   das soll laut ADR 0001 ein Buildfehler sein.

## Entscheidung

Die Quelle ist eine kleine, ausdrücklich definierte Zwischendarstellung in
`packages/protocol/src/ir.ts`: Structs, Enums, Konstanten und ein geschlossener Satz von
Feldtypen. Der Zod-Code wird daraus **generiert** wie Rust, C++ und Lua auch.

```
src/schemas/*.ts   ──►  IR (ir.ts)  ──┬─► generated/typescript/protocol.ts   (Zod + Typen)
  Deklarationen                       ├─► generated/rust/protocol.rs         (serde + validate)
                                      ├─► generated/cpp/fiveprotect_protocol.hpp (Structs + JSON)
                                      └─► generated/lua/protocol.lua         (Validatoren)
```

Damit bleibt die Entscheidung aus ADR 0001 unverändert — eine Quelle, vier Ziele. Nur die
Quelle ist jetzt die IR statt Zod, und Zod ist eines der vier Ziele.

## Konsequenzen

**Gut:** Die Generatoren hängen an einer Struktur, die dieses Repository besitzt. Ein
Zod-Update kann sie nicht brechen. Feldbeschreibungen wandern in alle vier Sprachen, und
`validateRegistry` fängt Reihenfolgefehler mit einer verständlichen Meldung ab, statt sie
als Fehler in einer generierten C++-Datei auftauchen zu lassen.

**Gut:** Ein unbekannter Feldtyp wirft `UnsupportedTypeError`. Ein neues Konstrukt muss
allen vier Generatoren beigebracht werden, sonst schlägt die Generierung fehl — das war
die Absicht von ADR 0001.

**Teuer:** Die IR ist absichtlich schmal. Ein Schema, das eine Union, eine Map oder einen
rekursiven Typ braucht, kann nicht einfach in Zod geschrieben werden — die IR muss zuerst
erweitert werden. Das bremst, und zwar bewusst: ein Konstrukt, das sich nicht in allen
vier Sprachen sauber abbilden lässt, gehört nicht in ein Protokoll, das über vier
Laufzeiten geht.

**Teuer:** Der generierte Zod-Code ist nicht handgeschrieben. Wer eine Validierung
anpassen will, muss den Generator ändern, nicht das Schema. Dafür ist der erzeugte Code
gewöhnlicher Zod-Quelltext und im Pull Request lesbar — kein Laufzeit-Fabrikaufruf, dessen
Ergebnis man sich denken muss.

## Verworfene Alternative

`zod-to-json-schema` plus Generatoren auf JSON Schema. Das verschiebt die Abhängigkeit von
Zod-Internas auf ein weiteres Werkzeug und bringt dieselben Lücken bei
Feldbeschreibungen und Deklarationsreihenfolge mit. Eine Ebene mehr, kein Problem weniger.
