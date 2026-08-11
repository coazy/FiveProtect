## Was ändert sich

<!-- Eine bis drei Sätze. Was tut der PR und warum. -->

## Bezug

<!-- Abschnitt im Designdokument, ADR oder Issue. Beispiel: Designdokument 5.1, Closes #12 -->

## Art der Änderung

- [ ] Neue Funktionalität
- [ ] Fehlerbehebung
- [ ] Umbau ohne Verhaltensänderung
- [ ] Nur Dokumentation
- [ ] Build / CI / Abhängigkeiten

## Prüfung

- [ ] `npm run verify` lokal grün
- [ ] Neue oder geänderte Logik ist durch Tests abgedeckt
- [ ] Bei Erkennungen: ein Negativfall vorhanden, der *nicht* anschlagen darf
- [ ] Protokolländerung? Dann `npm run protocol:generate` gelaufen und Artefakte committet

## Sicherheitsrelevanz

<!-- Betrifft der PR Attestation, Nonce, Lizenz, Localhost-Transport oder Mandantentrennung?
     Falls ja: welche Annahme ändert sich? Falls nein: "keine". -->

keine

## Datenschutz

<!-- Werden neue Daten vom Spieler-PC erhoben? Falls ja: welche, warum, mit welcher Frist?
     Abschnitt 13 des Designdokuments gilt. Falls nein: "keine neuen Daten". -->

keine neuen Daten
