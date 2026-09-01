# csv-dataview

Öffnet CSV-, TSV- und ähnliche Dateien in Pulsar als echte Tabelle statt als Textdatei —
mit fixierter Kopfzeile, Sortierung, verschiebbaren Spaltenbreiten, Filterfeld und
Bearbeiten direkt in den Zellen. Ein Klick wechselt jederzeit zur normalen Textansicht.

![Die Tabellenansicht mit Spaltenfiltern und Statistikleiste](media/screenshot.png)

## Installation

Nach der Veröffentlichung in der Pulsar Package Registry:

```bash
pulsar -p install csv-dataview
```

Vorher oder für eigene Änderungen: den Ordner nach `~/.pulsar/packages/csv-dataview`
kopieren und Pulsar neu starten.

```bash
# Linux / macOS
cp -r pulsar-csv-dataview ~/.pulsar/packages/csv-dataview

# Windows (PowerShell)
Copy-Item -Recurse pulsar-csv-dataview $env:USERPROFILE\.pulsar\packages\csv-dataview
```

Zum Entwickeln stattdessen `ppm link` im Paketordner ausführen und Pulsar mit
`pulsar --dev` starten. Tests laufen mit `ppm test`.

## Bedienung

Eine `.csv` per Doppelklick öffnen — sie erscheint direkt als Tabelle. Es wird kein
TextEditor angelegt, deshalb gibt es auch bei großen Dateien kein Syntax-Highlighting,
das im Hintergrund rechnet.

### Sortieren

| Aktion | Wie |
| --- | --- |
| Auf-/absteigend/aus | Klick auf den Spaltennamen, jeder Klick schaltet weiter |
| Nach mehreren Spalten | Shift-Klick hängt eine weitere Ebene an; die Ziffer im Kopf zeigt die Reihenfolge |
| Gezielt setzen | Rechtsklick auf den Spaltenkopf |
| Alles zurücksetzen | Rechtsklick → Sortierung aufheben |

Sortiert wird nach Spaltentyp: Zahlen numerisch (auch `1.234,56`), Datumsangaben
chronologisch, alles andere alphabetisch mit `Intl.Collator`. Leere Zellen landen
immer am Ende, und bei Gleichstand bleibt die Reihenfolge aus der Datei erhalten.

### Spalten

| Aktion | Wie |
| --- | --- |
| Breite ändern | Rechten Rand im Kopf ziehen |
| An Inhalt anpassen | Doppelklick auf den rechten Rand; Doppelklick auf die Ecke links oben macht alle |
| Verschieben | Spaltenkopf zur Seite ziehen, die Einfügemarke zeigt das Ziel |
| Ausblenden | Rechtsklick → Spalte ausblenden (Statuszeile bietet das Einblenden an) |

### Filtern

| Aktion | Wie |
| --- | --- |
| Gesamtfilter | Feld oben links, `ctrl-f` |
| Filterzeile je Spalte | `ctrl-shift-f` oder Knopf „Spaltenfilter“ |
| Filter löschen | `Escape` im jeweiligen Feld |

Beide Ebenen wirken zusammen: der Gesamtfilter und alle Spaltenfilter müssen zutreffen.

### Bearbeiten

| Aktion | Wie |
| --- | --- |
| Zelle bearbeiten | Doppelklick, `Enter` oder `F2`; ein Zeichen tippen beginnt direkt |
| Eingabe abschließen | `Enter` (eine Zeile tiefer), `Tab` (eine Spalte weiter), Shift kehrt die Richtung um |
| Abbrechen | `Escape` |
| Zellen leeren | `Entf` auf der Auswahl |
| Zeile einfügen | `ctrl-alt-n`, unterhalb der aktiven Zeile |
| Zeilen löschen | `ctrl-alt-r`, auf der Auswahl |
| Rückgängig / Wiederholen | `ctrl-z` / `ctrl-shift-z` |
| Speichern | `ctrl-s` oder der Knopf in der Leiste |

Geänderte Zellen bekommen einen farbigen Streifen, der Reiter zeigt den üblichen Punkt
für ungespeicherte Änderungen, und beim Schließen fragt Pulsar nach. Gespeichert wird
mit dem Trennzeichen und dem Zeilenende der Originaldatei.

Zwei Dinge, die beim Bearbeiten anders sind als erwartet werden könnte:

- Nach einer Änderung wird nicht neu gefiltert oder sortiert, sonst würde die Zeile
  unter dem Cursor wegspringen. Erst der nächste Filtervorgang ordnet neu ein.
- Beim Speichern wird die ganze Datei neu geschrieben, mit minimalem Quoting: Felder
  bekommen nur dann Anführungszeichen, wenn sie Trennzeichen, Anführungszeichen oder
  Umbrüche enthalten. Waren in der Originaldatei überflüssige Anführungszeichen, sind
  sie danach weg. Wer das nicht will, schaltet in den Einstellungen
  `quoteAllOnSave` ein.

### Auswahl, Kopieren, Springen

| Aktion | Wie |
| --- | --- |
| Zelle wählen | Klick, danach Pfeiltasten, `Bild ↑/↓`, `ctrl-Pos1`, `ctrl-Ende` |
| Bereich wählen | Shift-Klick oder Shift + Pfeiltasten, `ctrl-a` wählt alles |
| Auswahl kopieren | `ctrl-c` (tabgetrennt, direkt in Excel einfügbar) |
| … mit Spaltennamen | `ctrl-shift-c` |
| Sichtbare Zeilen als CSV | `ctrl-alt-c` |
| Zu Zeile springen | `ctrl-g` |
| Langen Wert ganz sehen | `alt-enter` |
| Statistik ein/aus | `ctrl-shift-s` oder der Σ-Knopf |
| Gefiltert speichern | `ctrl-alt-s`, legt `name.gefiltert.csv` daneben |
| Neu laden | `F5` |
| Zwischen Tabelle und Text wechseln | `ctrl-alt-t`, der Umschalter links in der Leiste, oder der Eintrag in der Statusleiste |

Die Σ-Leiste zeigt für die aktive Spalte oder die markierte Auswahl Anzahl, leere
Zellen, eindeutige Werte und bei Zahlen Summe, Mittelwert, Minimum und Maximum.
Über 500.000 Zellen wird erst auf Knopfdruck gerechnet, damit nichts hängt.

Der Umschalter oben links wechselt in die normale Textansicht und zurück; dasselbe
liegt als Eintrag in der Statusleiste, damit der Weg zurück auch aus dem TextEditor
heraus da ist. Stehen ungespeicherte Änderungen an, fragt Pulsar vor dem Wechsel.

Trennzeichen und Kopfzeile werden automatisch erkannt, lassen sich in der Leiste
oben aber jederzeit umstellen. Ändert sich die Datei auf der Platte, lädt die Ansicht
automatisch neu. Sortierung, Filter, Spaltenbreiten, -reihenfolge und ausgeblendete
Spalten überleben einen Neustart von Pulsar.

## Filtersprache

Das Feld oben links ist eine kleine Abfragesprache. Spaltennamen sind
Groß-/Kleinschreibung-egal; Namen mit Leerzeichen kommen in eckige Klammern.

```
berlin                              Volltextsuche über alle Spalten
umsatz > 1000                       numerischer Vergleich
land == DE and umsatz >= 1000       Verknüpfung
[Erste Spalte] contains gmbh        Teilstring
name == "Ber*"                      Platzhalter
status != offen or prio == 1        oder
not (land == DE)                    negieren
kommentar is empty                  leere Zellen
kommentar is not empty
datum >= 2024-01-01                 Datumsvergleich
name ~ ^Sch                         regulärer Ausdruck
$3 > 5                              Spalte per Nummer, wenn es keine Kopfzeile gibt
```

Operatoren: `== = != <> < <= > >= ~ =~ contains startswith endswith matches`,
Verknüpfung mit `and or not` bzw. `&& || !` und Klammern. Zahlen werden in beiden
Schreibweisen verstanden (`1.234,56` und `1,234.56`), Datumsangaben als
`2024-01-31`, `31.01.2024` und `01/31/2024`.

Ist der Ausdruck unvollständig, färbt sich das Feld und die Statuszeile nennt den
Fehler — gefiltert wird dann nicht.

Die Felder in der Spaltenfilterzeile sind bewusst kürzer gehalten: ohne Operator wird
als Teilstring gesucht, sonst gehen `> 100`, `<= 5`, `!= offen`, `Ber*`, `/^ab/`
sowie `empty` und `!empty`.

## Große Dateien

* Die Datei wird in 1-MB-Blöcken gestreamt, der Fortschritt steht in der Statuszeile.
* Gerendert werden nur die sichtbaren Zeilen plus ein kleiner Puffer, egal wie lang
  die Datei ist. Scrollen bleibt dadurch konstant schnell.
* Spaltenbreiten werden einmal aus einer Stichprobe berechnet und dann festgehalten
  (`table-layout: fixed`), damit die Tabelle beim Scrollen nicht springt.
* Ab 256 MB fragt das Paket vor dem Laden nach; die Grenze steht in den Einstellungen.
* Referenzwert auf einem Testrechner: 500.000 Zeilen (14 MB) in etwa einer Sekunde
  eingelesen, ein Filter über alle Zeilen in rund 340 ms.

Der begrenzende Faktor ist der Arbeitsspeicher, weil alle Zeilen als Strings gehalten
werden. Für Dateien im Gigabyte-Bereich hilft `Maximale Zeilenzahl` in den
Einstellungen: dann wird nach n Zeilen abgebrochen und die Statuszeile weist darauf hin.

## Einstellungen

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| `openAutomatically` | an | CSV-Dateien direkt als Tabelle öffnen |
| `extensions` | `csv, tsv, tab, psv` | welche Endungen die Tabelle übernimmt |
| `firstRowIsHeader` | an | erste Zeile als Kopfzeile deuten |
| `rowHeight` | 24 | Zeilenhöhe in Pixeln |
| `maxFileSizeMB` | 256 | ab welcher Größe nachgefragt wird (0 = nie) |
| `maxRows` | 0 | harte Obergrenze an Zeilen (0 = unbegrenzt) |
| `quoteAllOnSave` | aus | beim Speichern jedes Feld in Anführungszeichen setzen |

## Aufbau

```
lib/csv-parser.js   RFC-4180-Parser als Zustandsautomat, Trennzeichen- und Typerkennung
lib/csv-loader.js   Streaming über fs.createReadStream, Fortschritt und Abbruch
lib/query.js        Tokenizer und Recursive-Descent-Parser der Filtersprache
lib/column-filter.js  die kurzen Ausdrücke der Spaltenfilterzeile
lib/stats.js        Aggregate für die Σ-Leiste
lib/csv-view.js     das Workspace-Item: virtualisierte Tabelle, Sortierung, Auswahl
lib/main.js         Opener, Befehle, Einstellungen, Serialisierung
```

Die Ansicht ist ein reguläres Workspace-Item: sie überlebt einen Neustart von Pulsar
inklusive Filter und Sortierung, lässt sich in Panes ziehen und teilen.

## Lizenz

MIT

## Veröffentlichen

Vor dem ersten `pulsar -p publish` müssen in `package.json` `repository`, `author`
und `bugs` auf das eigene GitHub-Repository zeigen, und das Repository muss
öffentlich und gepusht sein. `version` steht bis dahin auf `0.0.0`; die erste
echte Version vergibt ppm.

```bash
pulsar -p login              # einmalig, legt den API-Token im Schlüsselbund ab
pulsar -p publish minor      # 0.0.0 -> 0.1.0, taggt, pusht und registriert
```

Ob der Name noch frei ist, zeigt
`https://packages.pulsar-edit.dev/packages/csv-dataview`.
