'use strict';

const fs = require('fs');
const path = require('path');
const { CompositeDisposable } = require('atom');

const CsvDataView = require('./csv-view');

const openAsText = new Set();   // einmalig am Tabellen-Opener vorbei
const openAsTable = new Set();  // einmalig erzwungen, egal welche Endung

function normalizedExtensions() {
  const raw = atom.config.get('csv-dataview.extensions') || '';
  return raw
    .split(/[,\s]+/)
    .map((e) => e.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
}

function isSupported(filePath) {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return extension.length > 0 && normalizedExtensions().includes(extension);
}

function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

module.exports = {
  config: {
    openAutomatically: {
      type: 'boolean',
      default: true,
      title: 'CSV-Dateien direkt als Tabelle öffnen',
      order: 1
    },
    extensions: {
      type: 'string',
      default: 'csv, tsv, tab, psv',
      title: 'Dateiendungen',
      description: 'Kommagetrennt, ohne Punkt.',
      order: 2
    },
    firstRowIsHeader: {
      type: 'boolean',
      default: true,
      title: 'Erste Zeile ist die Kopfzeile',
      order: 3
    },
    rowHeight: {
      type: 'integer',
      default: 24,
      minimum: 16,
      maximum: 60,
      title: 'Zeilenhöhe in Pixeln',
      order: 4
    },
    maxFileSizeMB: {
      type: 'integer',
      default: 256,
      minimum: 0,
      title: 'Rückfrage ab Dateigröße (MB)',
      description: 'Größere Dateien werden erst nach Bestätigung geladen. 0 schaltet die Rückfrage ab.',
      order: 5
    },
    quoteAllOnSave: {
      type: 'boolean',
      default: false,
      title: 'Beim Speichern alle Felder in Anführungszeichen setzen',
      description: 'Standard ist minimales Quoting: nur wo Trennzeichen, Anführungszeichen oder Umbrüche vorkommen.',
      order: 7
    },
    maxRows: {
      type: 'integer',
      default: 0,
      minimum: 0,
      title: 'Maximale Zeilenzahl',
      description: '0 bedeutet unbegrenzt. Begrenzt den Speicherverbrauch bei sehr großen Dateien.',
      order: 6
    }
  },

  activate() {
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(atom.workspace.addOpener((uri) => {
      if (typeof uri !== 'string' || uri.includes('://')) return undefined;

      if (openAsText.has(uri)) {
        openAsText.delete(uri);
        return undefined;
      }

      const forced = openAsTable.delete(uri);
      if (!forced) {
        if (!atom.config.get('csv-dataview.openAutomatically')) return undefined;
        if (!isSupported(uri)) return undefined;
      }
      if (!isReadableFile(uri)) return undefined;

      return new CsvDataView({ filePath: uri });
    }));

    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'csv-dataview:open-as-table': () => this.openAsTable(),
      'csv-dataview:open-as-text': () => this.openAsText(),
      'csv-dataview:toggle': () => this.toggle()
    }));
  },

  deactivate() {
    if (this.statusTile) this.statusTile.destroy();
    this.subscriptions.dispose();
  },

  // Anzeige in der Statusleiste: ein Klick wechselt zwischen Tabelle und Text.
  consumeStatusBar(statusBar) {
    const element = document.createElement('div');
    element.classList.add('inline-block', 'csv-dataview-switch');

    const link = document.createElement('span');
    link.classList.add('csv-dataview-switch-label');
    element.appendChild(link);
    element.addEventListener('click', () => this.toggle());

    const update = () => {
      const item = atom.workspace.getActivePaneItem();

      if (item instanceof CsvDataView) {
        element.style.display = '';
        link.textContent = 'Als Text öffnen';
        element.title = 'Diese Datei als normalen Text bearbeiten (ctrl-alt-t)';
        return;
      }

      const editor = atom.workspace.getActiveTextEditor();
      if (editor && item === editor && editor.getPath() && isSupported(editor.getPath())) {
        element.style.display = '';
        link.textContent = 'Als Tabelle öffnen';
        element.title = 'Diese Datei in der Tabellenansicht öffnen (ctrl-alt-t)';
        return;
      }

      element.style.display = 'none';
    };

    this.statusTile = statusBar.addRightTile({ item: element, priority: 100 });
    this.subscriptions.add(atom.workspace.onDidChangeActivePaneItem(update));
    update();
  },

  deserializeCsvDataView(state) {
    return CsvDataView.deserialize(state);
  },

  toggle() {
    const item = atom.workspace.getActivePaneItem();
    if (item instanceof CsvDataView) this.openAsText();
    else this.openAsTable();
  },

  openAsTable() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning('Die Datei muss zuerst gespeichert werden.');
      return;
    }
    if (editor.isModified()) {
      atom.notifications.addWarning('Ungespeicherte Änderungen – bitte zuerst speichern.');
      return;
    }

    const pane = atom.workspace.paneForItem(editor);
    openAsTable.add(filePath);
    Promise.resolve(pane.destroyItem(editor)).then(() => atom.workspace.open(filePath));
  },

  openAsText() {
    const item = atom.workspace.getActivePaneItem();
    if (!(item instanceof CsvDataView)) return;

    if (item.isModified()) {
      const choice = atom.confirm({
        message: 'Die Tabelle hat ungespeicherte Änderungen.',
        detailedMessage: 'Vor dem Wechsel in die Textansicht speichern?',
        buttons: ['Speichern und wechseln', 'Verwerfen', 'Abbrechen']
      });
      if (choice === 2) return;
      if (choice === 0) item.save();
    }

    const filePath = item.getURI();
    const pane = atom.workspace.paneForItem(item);
    openAsText.add(filePath);
    Promise.resolve(pane.destroyItem(item)).then(() => atom.workspace.open(filePath));
  }
};
