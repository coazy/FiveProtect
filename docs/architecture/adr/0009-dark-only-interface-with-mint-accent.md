# 0009 — Dunkle Oberfläche mit Mint-Akzent und Manrope

**Status:** Angenommen · 2026-08-04 · Ersetzt die Gestaltungsvorgaben aus Designdokument 12.3

## Kontext

Abschnitt 12.3 des Designdokuments legt fest: Systemschriftart (Segoe UI Variable),
neutrale Graustufen, genau eine Akzentfarbe, Hell- und Dunkelmodus folgen der
Systemeinstellung.

Bei der Umsetzung wurde eine andere Richtung vorgegeben: dunkles Grau mit Mint-Akzent,
Manrope als Schrift.

## Entscheidung

Die Oberfläche legt sich auf **Dunkel** fest, nutzt **Manrope** und **#4ADE9F** als
einzige Akzentfarbe. Ein Hellmodus wird nicht angeboten.

| | Designdokument 12.3 | Diese Fassung |
| --- | --- | --- |
| Schrift | Segoe UI Variable | Manrope, variabel 400–800 |
| Theme | folgt der Systemeinstellung | ausschließlich dunkel |
| Akzent | genau eine | genau eine, #4ADE9F |
| Verläufe, Glow, Emojis | keine | keine |
| Ausrichtung | linksbündig | linksbündig |
| Statusanzeige | schlichte zweispaltige Liste | schlichte zweispaltige Liste |

Die Disziplin aus 12.3 bleibt vollständig erhalten. Geändert haben sich Schrift und Theme,
nicht die Haltung.

## Begründung

**Warum kein Hellmodus.** Ein zweites Theme ist kein halber Aufwand, sondern ein zweiter
Satz Kontrastentscheidungen, der bei jeder Änderung mitgepflegt werden muss — und ein
Fenster, das neben einem Spiel im Vollbild steht, wird praktisch immer im Dunkeln gelesen.
Ein ungepflegter Hellmodus ist schlechter als keiner.

**Warum Manrope eingebettet und nicht nachgeladen.** Die Schrift liegt als woff2 im Binary.
Der Rechner, der den Blockiert-Bildschirm am dringendsten lesen muss, ist oft genau der,
dessen Netzwerk gerade nicht funktioniert; eine nachgeladene Schrift würde dort auf einen
Fallback zurückfallen und das Layout brechen. Der latin-Subset kostet 25 KB.

**Warum Mint.** Alles, was „in Ordnung" bedeutet, trägt diese eine Farbe und nichts sonst
trägt sie. Ein Blick auf das Fenster genügt damit für die einzige Frage, die der Spieler
hat. Bernstein und Rose sind semantische Farben für Warnung und Blockade und zählen
ausdrücklich nicht als zweiter Akzent.

## Konsequenzen

**Gut:** Eine visuelle Sprache statt zweier. Die Farbmarken liegen als CSS-Variablen an
einer Stelle, und die Vorschau nutzt dieselbe Render-Logik wie das ausgelieferte Fenster —
beide können nicht auseinanderlaufen.

**Teuer:** Spieler mit heller Systemeinstellung bekommen ein Fenster, das aus der Reihe
fällt. Das ist der Preis dafür, ein Theme richtig zu machen statt zwei halb.

**Nicht verhandelbar geblieben:** kein zweiter Akzent, keine Verläufe, kein Glow, keine
Emojis in der Oberfläche, keine erfundenen Prozentwerte im Fortschrittsbalken.
