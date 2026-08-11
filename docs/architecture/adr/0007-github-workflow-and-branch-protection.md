# 0007 — GitHub-Workflow und Grenzen der Branch-Absicherung

**Status:** Angenommen · 2026-08-04

## Kontext

Das Repository ist privat und liegt auf dem kostenlosen GitHub-Plan. Branch-Rulesets und
Required Status Checks sind dort nicht verfügbar:

```
POST /repos/coazy/FiveProtect/rulesets
→ 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

Dieselbe Grenze trifft die Codeanalyse. CodeQL benötigt GitHub Advanced Security; ohne sie
scheitert der Analyse-Job schon beim Checkout:

```
remote: Repository not found.
fatal: repository 'https://github.com/coazy/FiveProtect/' not found
```

Das Repository kann nicht öffentlich werden — es enthält Erkennungslogik, deren Wirkung
von Nichtoffenlegung abhängt.

## Entscheidung

Der Workflow wird vollständig aufgesetzt, aber technisch nur so weit erzwungen, wie der
Plan es zulässt:

**Technisch erzwungen:**
- Squash-Merge ist die einzige erlaubte Merge-Methode (Repository-Einstellung).
- Merge-Commits und Rebase-Merges sind deaktiviert.
- Branches werden nach dem Merge automatisch gelöscht.
- Die CI läuft auf jedem Pull Request und auf `main`.

**Per Konvention, dokumentiert in `CONTRIBUTING.md`:**
- Keine direkten Pushes auf `main`.
- Kein Merge bei roter CI.

**Statt CodeQL:** ein Abhängigkeits-Audit in der CI (`npm audit --audit-level=high` und
`cargo audit`). Das deckt bekannte Schwachstellen in Fremdcode ab, aber keine im eigenen —
eine echte Lücke, kein gleichwertiger Ersatz. Sie wird getragen, bis der Plan wechselt.

## Warum trotzdem der volle Ablauf

Der Ablauf ist der Wert, nicht seine Durchsetzung durch die Plattform. Feature-Branch,
Pull Request mit ausgefüllter Vorlage und Squash-Merge erzeugen eine `main`-Historie mit
einer nachvollziehbaren Änderung je Commit — auch ohne serverseitige Sperre. Sobald der
Plan wechselt, ist die Absicherung eine einzelne API-Anfrage; das fertige Ruleset liegt
dafür in `.github/rulesets/protect-main.json` bereit.

## Konsequenzen

**Gut:** Der Ablauf ist ab dem ersten Commit etabliert und muss später nicht nachgeholt
werden. Die Historie ist sauber.

**Teuer:** Ein versehentlicher direkter Push auf `main` wird nicht verhindert. Bei einem
Einzelentwickler ist das tragbar; sobald eine zweite Person mitarbeitet, wird der
Plan-Wechsel fällig.

**Nachzuholen bei GitHub Pro:**

```bash
gh api -X POST repos/coazy/FiveProtect/rulesets \
  --input .github/rulesets/protect-main.json
```
