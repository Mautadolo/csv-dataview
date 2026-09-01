'use strict';

const fs = require('fs');
const path = require('path');
const { Emitter, CompositeDisposable, File } = require('atom');

const csv = require('./csv-parser');
const { loadCsvFile } = require('./csv-loader');
const { parseQuery } = require('./query');
const { compileColumnFilter } = require('./column-filter');
const { summarize, columnValues, rangeValues } = require('./stats');

const OVERSCAN = 8;
const MIN_COLUMN_WIDTH = 48;
const MAX_AUTO_WIDTH = 420;
const STATS_AUTO_LIMIT = 500000; // Zellen, die ohne Nachfrage ausgewertet werden

class CsvDataView {
  static deserialize(state) {
    try {
      if (state && state.filePath && fs.statSync(state.filePath).isFile()) {
        return new CsvDataView(state);
      }
    } catch (error) {
      // Datei existiert nicht mehr – Item wird verworfen
    }
    return null;
  }

  constructor(state = {}) {
    this.filePath = state.filePath;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();

    this.delimiterSetting = state.delimiterSetting || 'auto';
    this.hasHeader = state.hasHeader != null
      ? state.hasHeader
      : atom.config.get('csv-dataview.firstRowIsHeader');
    this.queryText = state.queryText || '';
    this.sorts = Array.isArray(state.sorts) ? state.sorts : [];
    this.columnFilters = new Map(Object.entries(state.columnFilters || {}).map(
      ([key, value]) => [Number(key), value]
    ));
    this.showColumnFilters = Boolean(state.showColumnFilters) || this.columnFilters.size > 0;
    this.showStats = Boolean(state.showStats);
    this.savedLayout = state.layout || null;

    this.rowHeight = Math.max(16, atom.config.get('csv-dataview.rowHeight') || 24);
    this.rawRows = [];
    this.rows = [];
    this.header = [];
    this.types = [];
    this.widths = [];
    this.order = [];
    this.hidden = new Set();
    this.visible = [];
    this.view = [];
    this.focus = null;   // {row, pos} – Zeile im Filterergebnis, Position in visible
    this.anchor = null;
    this.headerRow = null;   // die Kopfzeile im Original, so wie sie gespeichert wird
    this.lineEnding = '\n';
    this.dirty = false;
    this.editing = null;
    this.editedRows = new WeakMap(); // Zeile -> Set geänderter Spalten
    this.undoStack = [];
    this.redoStack = [];
    this.savedDepth = 0;
    this.renderedKey = null;
    this.loader = null;

    this.buildElement();
    this.registerCommands();
    this.watchFile();
    this.load();
  }

  // ---------------------------------------------------------------- Workspace

  getElement() { return this.element; }
  getTitle() { return this.filePath ? path.basename(this.filePath) : 'CSV'; }
  getLongTitle() { return this.getTitle(); }
  getURI() { return this.filePath; }
  getPath() { return this.filePath; }
  getIconName() { return 'file-text'; }
  isModified() { return this.dirty; }
  shouldPromptToSave() { return this.dirty; }
  onDidDestroy(callback) { return this.emitter.on('did-destroy', callback); }
  onDidChangeModified(callback) { return this.emitter.on('did-change-modified', callback); }
  onDidChangeTitle(callback) { return this.emitter.on('did-change-title', callback); }

  serialize() {
    const columnFilters = {};
    for (const [column, text] of this.columnFilters) columnFilters[column] = text;

    return {
      deserializer: 'CsvDataView',
      filePath: this.filePath,
      delimiterSetting: this.delimiterSetting,
      hasHeader: this.hasHeader,
      queryText: this.queryText,
      sorts: this.sorts,
      columnFilters,
      showColumnFilters: this.showColumnFilters,
      showStats: this.showStats,
      layout: {
        columns: this.header.length,
        order: this.order,
        hidden: Array.from(this.hidden),
        widths: this.widths
      }
    };
  }

  destroy() {
    if (this.loader) this.loader.cancel();
    clearTimeout(this.statsTimer);
    clearTimeout(this.reloadTimer);
    this.disposables.dispose();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.element.parentNode) this.element.parentNode.removeChild(this.element);
    this.emitter.emit('did-destroy');
    this.emitter.dispose();
  }

  // ------------------------------------------------------------------- Aufbau

  buildElement() {
    const element = document.createElement('div');
    element.classList.add('csv-dataview');
    element.tabIndex = -1;
    this.element = element;

    element.appendChild(this.buildToolbar());

    this.status = document.createElement('div');
    this.status.classList.add('csv-dataview-status');
    element.appendChild(this.status);

    this.scroller = document.createElement('div');
    this.scroller.classList.add('csv-dataview-scroller');

    this.table = document.createElement('table');
    this.table.classList.add('csv-dataview-table');
    this.colgroup = document.createElement('colgroup');
    this.thead = document.createElement('thead');
    this.tbody = document.createElement('tbody');
    this.table.appendChild(this.colgroup);
    this.table.appendChild(this.thead);
    this.table.appendChild(this.tbody);
    this.scroller.appendChild(this.table);
    element.appendChild(this.scroller);

    this.statsBar = document.createElement('div');
    this.statsBar.classList.add('csv-dataview-stats');
    this.statsBar.style.display = this.showStats ? '' : 'none';
    element.appendChild(this.statsBar);

    this.inspector = document.createElement('div');
    this.inspector.classList.add('csv-dataview-inspector');
    this.inspector.style.display = 'none';
    element.appendChild(this.inspector);

    let ticking = false;
    this.scroller.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        this.renderRows();
      });
    });

    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.renderRows());
      this.resizeObserver.observe(this.scroller);
    }

    element.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.tbody.addEventListener('mousedown', (event) => this.onCellMouseDown(event));
    this.tbody.addEventListener('dblclick', () => this.beginEdit());
  }

  buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.classList.add('csv-dataview-toolbar');

    const modes = document.createElement('div');
    modes.classList.add('btn-group', 'btn-group-sm', 'csv-dataview-modes');
    const tableButton = this.button('Tabelle', () => {});
    tableButton.classList.add('selected');
    tableButton.title = 'Tabellenansicht (aktiv)';
    const textButton = this.button('Text', () => {
      atom.commands.dispatch(this.element, 'csv-dataview:open-as-text');
    });
    textButton.title = 'Als normalen Text öffnen (ctrl-alt-t)';
    modes.appendChild(tableButton);
    modes.appendChild(textButton);
    toolbar.appendChild(modes);

    this.queryInput = document.createElement('input');
    this.queryInput.type = 'text';
    this.queryInput.classList.add('input-text', 'native-key-bindings', 'csv-dataview-query');
    this.queryInput.placeholder = 'Filter, z. B.  betrag > 100 and land == "DE"';
    this.queryInput.value = this.queryText;
    toolbar.appendChild(this.queryInput);

    let debounce = null;
    this.queryInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.queryText = this.queryInput.value;
        this.applyQuery();
      }, 130);
    });
    this.queryInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.queryInput.value = '';
        this.queryText = '';
        this.applyQuery();
        this.element.focus();
        event.stopPropagation();
      }
    });

    const controls = document.createElement('div');
    controls.classList.add('csv-dataview-controls');

    this.filterToggle = this.button('Spaltenfilter', () => this.toggleColumnFilters());
    this.filterToggle.classList.toggle('selected', this.showColumnFilters);
    controls.appendChild(this.filterToggle);

    this.statsToggle = this.button('Σ', () => this.toggleStats());
    this.statsToggle.title = 'Statistik zur ausgewählten Spalte oder Auswahl';
    this.statsToggle.classList.toggle('selected', this.showStats);
    controls.appendChild(this.statsToggle);

    this.delimiterSelect = document.createElement('select');
    this.delimiterSelect.classList.add('input-select');
    const options = [
      ['auto', 'Trennzeichen: auto'],
      [',', 'Komma'],
      [';', 'Semikolon'],
      ['\t', 'Tab'],
      ['|', 'Pipe']
    ];
    for (const [value, label] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (value === this.delimiterSetting) option.selected = true;
      this.delimiterSelect.appendChild(option);
    }
    this.delimiterSelect.addEventListener('change', () => {
      this.delimiterSetting = this.delimiterSelect.value;
      this.load();
    });
    controls.appendChild(this.delimiterSelect);

    const headerLabel = document.createElement('label');
    headerLabel.classList.add('input-label', 'csv-dataview-checkbox');
    this.headerCheckbox = document.createElement('input');
    this.headerCheckbox.type = 'checkbox';
    this.headerCheckbox.classList.add('input-checkbox');
    this.headerCheckbox.checked = this.hasHeader;
    this.headerCheckbox.addEventListener('change', () => {
      this.hasHeader = this.headerCheckbox.checked;
      this.sorts = [];
      this.savedLayout = null;
      this.applyRawRows();
    });
    headerLabel.appendChild(this.headerCheckbox);
    headerLabel.appendChild(document.createTextNode(' Kopfzeile'));
    controls.appendChild(headerLabel);

    this.saveButton = this.button('Speichern', () => this.save());
    this.saveButton.title = 'Änderungen in die Datei schreiben (ctrl-s)';
    this.saveButton.disabled = true;
    controls.appendChild(this.saveButton);

    controls.appendChild(this.button('Neu laden', () => this.load()));
    controls.appendChild(this.button('Gefiltert speichern', () => this.saveFiltered()));

    toolbar.appendChild(controls);
    return toolbar;
  }

  button(label, onClick) {
    const button = document.createElement('button');
    button.classList.add('btn', 'btn-sm');
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  registerCommands() {
    this.disposables.add(atom.commands.add(this.element, {
      'csv-dataview:focus-filter': () => { this.queryInput.focus(); this.queryInput.select(); },
      'csv-dataview:toggle-column-filters': () => this.toggleColumnFilters(),
      'csv-dataview:toggle-stats': () => this.toggleStats(),
      'csv-dataview:reload': () => this.load(),
      'csv-dataview:copy-selection': () => this.copySelection(false),
      'csv-dataview:copy-with-header': () => this.copySelection(true),
      'csv-dataview:copy-as-csv': () => this.copyVisibleAsCsv(),
      'csv-dataview:save-filtered': () => this.saveFiltered(),
      'csv-dataview:go-to-row': () => this.promptGoToRow(),
      'csv-dataview:show-value': () => this.showValue(),
      'csv-dataview:edit-cell': () => this.beginEdit(),
      'csv-dataview:clear-cells': () => this.clearSelection(),
      'csv-dataview:insert-row': () => this.insertRow(),
      'csv-dataview:delete-rows': () => this.deleteSelectedRows(),
      'core:undo': () => this.undo(),
      'core:redo': () => this.redo(),
      'csv-dataview:select-all': () => this.selectAll(),
      'csv-dataview:sort-ascending': (event) => this.sortFromEvent(event, 'asc'),
      'csv-dataview:sort-descending': (event) => this.sortFromEvent(event, 'desc'),
      'csv-dataview:add-sort': (event) => this.sortFromEvent(event, 'add'),
      'csv-dataview:clear-sort': () => { this.sorts = []; this.applyQuery(); this.renderHeader(); },
      'csv-dataview:hide-column': (event) => {
        const column = this.columnFromEvent(event);
        if (column != null) this.hideColumn(column);
      },
      'csv-dataview:show-all-columns': () => this.showAllColumns(),
      'csv-dataview:fit-column': (event) => {
        const column = this.columnFromEvent(event);
        if (column != null) this.autoFit(column);
      },
      'csv-dataview:fit-all-columns': () => this.autoFitAll()
    }));
  }

  columnFromEvent(event) {
    const cell = event.target.closest && event.target.closest('[data-column]');
    if (cell) return Number(cell.dataset.column);
    if (this.focus) return this.visible[this.focus.pos];
    return null;
  }

  sortFromEvent(event, mode) {
    const column = this.columnFromEvent(event);
    if (column == null) return;
    if (mode === 'add') this.toggleSort(column, true);
    else this.setSort(column, mode);
  }

  watchFile() {
    if (!this.filePath) return;
    try {
      const file = new File(this.filePath);
      this.disposables.add(file.onDidChange(() => {
        if (this.suppressReloadUntil && Date.now() < this.suppressReloadUntil) return;
        if (this.dirty) {
          this.setMessage('Die Datei wurde extern geändert. Ungespeicherte Änderungen bleiben stehen — „Neu laden“ verwirft sie.');
          return;
        }
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.load(), 250);
      }));
      this.disposables.add(file.onDidDelete(() => this.setMessage('Datei wurde gelöscht.')));
    } catch (error) {
      // Watcher ist optional
    }
  }

  // -------------------------------------------------------------------- Laden

  load() {
    if (this.loader) this.loader.cancel();
    this.setMessage('Lade …');

    const limitMb = atom.config.get('csv-dataview.maxFileSizeMB') || 0;
    if (limitMb > 0 && !this.confirmedLargeFile) {
      let size = 0;
      try { size = fs.statSync(this.filePath).size; } catch (error) { size = 0; }
      if (size > limitMb * 1024 * 1024) {
        this.askBeforeLoading(size);
        return;
      }
    }

    const delimiter = this.delimiterSetting === 'auto' ? null : this.delimiterSetting;
    const maxRows = atom.config.get('csv-dataview.maxRows') || 0;

    this.loader = loadCsvFile(this.filePath, {
      delimiter,
      maxRows,
      onProgress: ({ rows, bytes, total }) => {
        const percent = total ? Math.round((bytes / total) * 100) : 0;
        this.setMessage(`Lade … ${formatCount(rows)} Zeilen (${percent} %)`);
      }
    });

    this.loader.promise.then((result) => {
      this.loader = null;
      if (!result) return; // abgebrochen
      this.detectedDelimiter = result.delimiter;
      this.lineEnding = result.lineEnding || '\n';
      this.truncated = result.truncated;
      this.rawRows = result.rows;
      this.rawWidth = result.width;
      this.applyRawRows();
    }).catch((error) => {
      this.loader = null;
      this.setMessage(`Fehler beim Lesen: ${error.message}`);
    });
  }

  askBeforeLoading(size) {
    const mb = (size / 1024 / 1024).toFixed(1);
    this.setMessage(`Die Datei ist ${mb} MB groß. `);
    this.status.appendChild(this.button('Trotzdem laden', () => {
      this.confirmedLargeFile = true;
      this.load();
    }));
  }

  applyRawRows() {
    const rows = this.rawRows;
    const width = this.rawWidth || (rows[0] ? rows[0].length : 0);

    if (this.hasHeader && rows.length > 0) {
      this.headerRow = rows[0];
      this.header = rows[0].map((name, i) => (String(name).trim() || `Spalte ${i + 1}`));
      this.rows = rows.slice(1);
    } else {
      this.headerRow = null;
      this.header = new Array(width).fill(null).map((_, i) => `Spalte ${i + 1}`);
      this.rows = rows;
    }

    this.editedRows = new WeakMap();
    this.undoStack = [];
    this.redoStack = [];
    this.savedDepth = 0;
    this.setDirty(false);

    this.types = csv.inferTypes(this.rows, this.header.length);

    const layout = this.savedLayout;
    if (layout && layout.columns === this.header.length) {
      this.order = layout.order.slice();
      this.hidden = new Set(layout.hidden || []);
      this.widths = layout.widths.slice();
    } else {
      this.order = this.header.map((_, i) => i);
      this.hidden = new Set();
      this.widths = this.computeWidths();
    }
    this.savedLayout = null;

    this.focus = null;
    this.anchor = null;
    this.hideValue();
    this.renderHeader();
    this.applyQuery();
  }

  // ------------------------------------------------------------------ Spalten

  updateVisibleColumns() {
    this.visible = this.order.filter((column) => !this.hidden.has(column));
    if (this.visible.length === 0 && this.order.length > 0) {
      this.hidden.clear();
      this.visible = this.order.slice();
    }
  }

  hideColumn(column) {
    if (this.visible.length <= 1) return;
    this.hidden.add(column);
    this.focus = null;
    this.anchor = null;
    this.renderHeader();
    this.renderRows(true);
    this.updateStatus();
  }

  showAllColumns() {
    if (this.hidden.size === 0) return;
    this.hidden.clear();
    this.renderHeader();
    this.renderRows(true);
    this.updateStatus();
  }

  moveColumn(column, insertPosition) {
    const before = insertPosition < this.visible.length ? this.visible[insertPosition] : null;
    if (before === column) return;

    const order = this.order.filter((c) => c !== column);
    let target = before === null ? order.length : order.indexOf(before);
    if (target < 0) target = order.length;
    order.splice(target, 0, column);
    this.order = order;

    this.focus = null;
    this.anchor = null;
    this.renderHeader();
    this.renderRows(true);
  }

  // ------------------------------------------------------------------ Filtern

  buildPredicates() {
    const predicates = [];
    this.queryError = null;

    const source = (this.queryText || '').trim();
    if (source) {
      const result = parseQuery(source, this.header);
      if (!result.ok) this.queryError = result.error;
      else if (result.predicate) predicates.push(result.predicate);
    }

    for (const [column, text] of this.columnFilters) {
      if (column >= this.header.length) continue;
      const predicate = compileColumnFilter(text, column, this.types[column]);
      if (predicate) predicates.push(predicate);
    }
    return predicates;
  }

  applyQuery(preserve = false) {
    const scrollTop = this.scroller.scrollTop;
    const previousFocus = this.focus;
    const previousAnchor = this.anchor;
    const predicates = this.buildPredicates();
    this.queryInput.classList.toggle('csv-dataview-query-error', Boolean(this.queryError));

    const view = [];
    const rows = this.rows;

    if (predicates.length === 0) {
      for (let i = 0; i < rows.length; i++) view.push(i);
    } else if (predicates.length === 1) {
      const predicate = predicates[0];
      for (let i = 0; i < rows.length; i++) if (predicate(rows[i])) view.push(i);
    } else {
      outer:
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (const predicate of predicates) if (!predicate(row)) continue outer;
        view.push(i);
      }
    }

    this.view = view;
    this.applySort();

    if (preserve) {
      this.focus = this.clampPosition(previousFocus);
      this.anchor = this.clampPosition(previousAnchor);
      this.scroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, this.view.length * this.rowHeight - this.scroller.clientHeight)
      );
    } else {
      this.focus = null;
      this.anchor = null;
      this.scroller.scrollTop = 0;
    }

    this.renderRows(true);
    this.updateStatus();
    this.scheduleStats();
  }

  clampPosition(position) {
    if (!position || this.view.length === 0 || this.visible.length === 0) return null;
    return {
      row: Math.min(position.row, this.view.length - 1),
      pos: Math.min(position.pos, this.visible.length - 1)
    };
  }

  applySort() {
    if (this.sorts.length === 0) return;
    const specs = this.sorts
      .filter((sort) => sort.column < this.header.length)
      .map((sort) => ({
        column: sort.column,
        sign: sort.direction === 'desc' ? -1 : 1,
        type: this.types[sort.column]
      }));
    if (specs.length === 0) return;

    const rows = this.rows;
    this.view.sort((a, b) => {
      for (const spec of specs) {
        const result = csv.compareValues(rows[a][spec.column], rows[b][spec.column], spec.type);
        if (result !== 0) return spec.sign * result;
      }
      return a - b; // stabil: Reihenfolge in der Datei
    });
  }

  sortIndex(column) {
    return this.sorts.findIndex((sort) => sort.column === column);
  }

  // Klick: auf- → absteigend → aus. Shift-Klick hängt eine weitere Ebene an.
  toggleSort(column, additive) {
    const index = this.sortIndex(column);

    if (!additive) {
      if (index === 0 && this.sorts.length === 1) {
        if (this.sorts[0].direction === 'asc') this.sorts = [{ column, direction: 'desc' }];
        else this.sorts = [];
      } else {
        this.sorts = [{ column, direction: 'asc' }];
      }
    } else if (index === -1) {
      this.sorts = this.sorts.concat([{ column, direction: 'asc' }]);
    } else if (this.sorts[index].direction === 'asc') {
      this.sorts = this.sorts.slice();
      this.sorts[index] = { column, direction: 'desc' };
    } else {
      this.sorts = this.sorts.filter((sort) => sort.column !== column);
    }

    this.applyQuery();
    this.renderHeader();
  }

  setSort(column, direction) {
    this.sorts = [{ column, direction }];
    this.applyQuery();
    this.renderHeader();
  }

  toggleColumnFilters() {
    this.showColumnFilters = !this.showColumnFilters;
    this.filterToggle.classList.toggle('selected', this.showColumnFilters);
    if (!this.showColumnFilters && this.columnFilters.size > 0) {
      this.columnFilters.clear();
      this.renderHeader();
      this.applyQuery();
      return;
    }
    this.renderHeader();
    this.renderRows(true);
    if (this.showColumnFilters) {
      const first = this.thead.querySelector('.csv-dataview-column-filter');
      if (first) first.focus();
    }
  }

  // ------------------------------------------------------------------ Rendern

  measureText(text) {
    if (!this.measureContext) {
      const canvas = document.createElement('canvas');
      this.measureContext = canvas.getContext('2d');
      const style = window.getComputedStyle(this.element);
      this.measureContext.font = `${style.fontSize} ${style.fontFamily}`;
    }
    return this.measureContext.measureText(text).width;
  }

  computeWidths() {
    const sample = Math.min(this.rows.length, 300);
    return this.header.map((name, column) => {
      let longest = String(name);
      for (let i = 0; i < sample; i++) {
        const value = this.rows[i][column];
        if (value && value.length > longest.length) longest = value;
      }
      const width = Math.ceil(this.measureText(longest)) + 26;
      return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_AUTO_WIDTH, width));
    });
  }

  gutterWidth() {
    const digits = String(this.rows.length || 1).length;
    return Math.max(38, digits * 9 + 18);
  }

  renderHeader() {
    this.updateVisibleColumns();

    this.colgroup.replaceChildren();
    const gutterCol = document.createElement('col');
    gutterCol.style.width = `${this.gutterWidth()}px`;
    this.colgroup.appendChild(gutterCol);
    for (const column of this.visible) {
      const col = document.createElement('col');
      col.style.width = `${this.widths[column]}px`;
      this.colgroup.appendChild(col);
    }

    const headerRow = document.createElement('tr');
    headerRow.classList.add('csv-dataview-header-row');
    const corner = document.createElement('th');
    corner.classList.add('csv-dataview-gutter');
    corner.title = 'Doppelklick: alle Spalten an den Inhalt anpassen';
    corner.addEventListener('dblclick', () => this.autoFitAll());
    headerRow.appendChild(corner);

    this.visible.forEach((column, position) => {
      const cell = document.createElement('th');
      cell.dataset.column = String(column);
      cell.classList.add(`csv-type-${this.types[column]}`);

      const sortIndex = this.sortIndex(column);
      if (sortIndex !== -1) {
        cell.classList.add(this.sorts[sortIndex].direction === 'asc' ? 'sort-asc' : 'sort-desc');
      }

      const label = document.createElement('span');
      label.classList.add('csv-dataview-header-label');
      label.textContent = this.header[column];
      label.title = `${this.header[column]} · ${this.typeLabel(this.types[column])}\n`
        + 'Klick sortiert, Shift-Klick sortiert zusätzlich, Ziehen verschiebt die Spalte';
      label.addEventListener('mousedown', (event) => this.startHeaderInteraction(event, column));
      cell.appendChild(label);

      if (sortIndex !== -1 && this.sorts.length > 1) {
        const badge = document.createElement('span');
        badge.classList.add('csv-dataview-sort-badge');
        badge.textContent = String(sortIndex + 1);
        cell.appendChild(badge);
      }

      const handle = document.createElement('span');
      handle.classList.add('csv-dataview-resizer');
      handle.title = 'Ziehen: Breite ändern · Doppelklick: an Inhalt anpassen';
      handle.addEventListener('mousedown', (event) => this.startResize(event, column, position));
      handle.addEventListener('dblclick', () => this.autoFit(column));
      cell.appendChild(handle);

      headerRow.appendChild(cell);
    });

    const rows = [headerRow];

    if (this.showColumnFilters) {
      const filterRow = document.createElement('tr');
      filterRow.classList.add('csv-dataview-filter-row');
      const filterCorner = document.createElement('th');
      filterCorner.classList.add('csv-dataview-gutter');
      filterRow.appendChild(filterCorner);

      for (const column of this.visible) {
        const cell = document.createElement('th');
        cell.dataset.column = String(column);
        const input = document.createElement('input');
        input.type = 'text';
        input.classList.add('input-text', 'native-key-bindings', 'csv-dataview-column-filter');
        input.value = this.columnFilters.get(column) || '';
        input.placeholder = this.types[column] === 'number' ? '> 100' : 'Filter';
        input.title = 'Teilstring, oder > 100 · != x · Ber* · /regex/ · empty';

        let debounce = null;
        input.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            const value = input.value.trim();
            if (value) this.columnFilters.set(column, value);
            else this.columnFilters.delete(column);
            input.classList.toggle('active', Boolean(value));
            this.applyQuery();
          }, 160);
        });
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            input.value = '';
            this.columnFilters.delete(column);
            input.classList.remove('active');
            this.applyQuery();
            event.stopPropagation();
          }
        });
        if (input.value) input.classList.add('active');

        cell.appendChild(input);
        filterRow.appendChild(cell);
      }
      rows.push(filterRow);
    }

    this.thead.replaceChildren(...rows);
    this.updateTableWidth();

    window.requestAnimationFrame(() => {
      const height = headerRow.offsetHeight;
      for (const cell of this.thead.querySelectorAll('.csv-dataview-filter-row th')) {
        cell.style.top = `${height}px`;
      }
    });
  }

  typeLabel(type) {
    if (type === 'number') return 'Zahl';
    if (type === 'date') return 'Datum';
    return 'Text';
  }

  updateTableWidth() {
    const total = this.visible.reduce((sum, column) => sum + this.widths[column], this.gutterWidth());
    this.table.style.width = `${total}px`;
  }

  renderRows(force = false) {
    if (this.editing && !force) return; // sonst verschwindet das Eingabefeld
    const rowHeight = this.rowHeight;
    const total = this.view.length;
    const scrollTop = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight || 600;

    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN);

    const key = `${start}:${end}:${total}`;
    if (!force && this.renderedKey === key) return;
    this.renderedKey = key;

    const selection = this.selectionBounds();
    const columnCount = this.visible.length + 1;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(spacer(start * rowHeight, columnCount));

    for (let i = start; i < end; i++) {
      const rowIndex = this.view[i];
      const row = this.rows[rowIndex];
      const tr = document.createElement('tr');
      tr.style.height = `${rowHeight}px`;
      tr.dataset.viewIndex = String(i);
      if (i % 2 === 1) tr.classList.add('odd'); // Streifen unabhängig vom DOM-Ausschnitt

      const inRows = selection && i >= selection.rowFrom && i <= selection.rowTo;
      if (inRows) tr.classList.add('selected');
      const edited = this.editedRows.get(row);

      const gutter = document.createElement('td');
      gutter.classList.add('csv-dataview-gutter');
      gutter.textContent = formatCount(rowIndex + 1);
      tr.appendChild(gutter);

      for (let position = 0; position < this.visible.length; position++) {
        const column = this.visible[position];
        const td = document.createElement('td');
        const value = row[column];
        td.dataset.column = String(column);
        td.dataset.position = String(position);
        if (this.types[column] === 'number') td.classList.add('numeric');
        if (edited && edited.has(column)) td.classList.add('edited');

        if (value == null || value === '') {
          td.classList.add('empty');
        } else {
          td.textContent = value;
          if (value.length > 12) td.title = value;
        }

        if (inRows && position >= selection.posFrom && position <= selection.posTo) {
          td.classList.add('in-range');
        }
        if (this.focus && this.focus.row === i && this.focus.pos === position) {
          td.classList.add('selected-cell');
        }
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }

    fragment.appendChild(spacer((total - end) * rowHeight, columnCount));
    this.tbody.replaceChildren(fragment);
  }

  // ------------------------------------------------- Breite, Reihenfolge

  startResize(event, column, position) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = this.widths[column];

    const onMove = (moveEvent) => {
      const width = Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX));
      this.widths[column] = width;
      this.colgroup.children[position + 1].style.width = `${width}px`;
      this.updateTableWidth();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  autoFit(column) {
    let longest = String(this.header[column]);
    const limit = Math.min(this.view.length, 2000);
    for (let i = 0; i < limit; i++) {
      const value = this.rows[this.view[i]][column];
      if (value && value.length > longest.length) longest = value;
    }
    this.widths[column] = Math.max(MIN_COLUMN_WIDTH, Math.ceil(this.measureText(longest)) + 26);
    const position = this.visible.indexOf(column);
    if (position !== -1) this.colgroup.children[position + 1].style.width = `${this.widths[column]}px`;
    this.updateTableWidth();
  }

  autoFitAll() {
    for (const column of this.visible) this.autoFit(column);
  }

  // Ohne Bewegung ist der Klick eine Sortierung, mit Bewegung ein Verschieben.
  startHeaderInteraction(event, column) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    let dragging = false;
    let dropPosition = null;

    const onMove = (moveEvent) => {
      if (!dragging && Math.abs(moveEvent.clientX - startX) < 6) return;
      dragging = true;
      this.element.classList.add('csv-dataview-dragging');
      dropPosition = this.dropPositionAt(moveEvent.clientX);
      this.highlightDrop(dropPosition);
    };

    const onUp = (upEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.element.classList.remove('csv-dataview-dragging');
      this.clearDropHighlight();

      if (dragging) {
        if (dropPosition != null) this.moveColumn(column, dropPosition);
      } else {
        this.toggleSort(column, upEvent.shiftKey);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  dropPositionAt(clientX) {
    const rect = this.table.getBoundingClientRect();
    const x = clientX - rect.left - this.gutterWidth();
    let accumulated = 0;
    for (let position = 0; position < this.visible.length; position++) {
      const width = this.widths[this.visible[position]];
      if (x < accumulated + width / 2) return position;
      accumulated += width;
    }
    return this.visible.length;
  }

  highlightDrop(position) {
    this.clearDropHighlight();
    const cells = this.thead.querySelectorAll('.csv-dataview-header-row th[data-column]');
    if (position < cells.length) cells[position].classList.add('drop-before');
    else if (cells.length) cells[cells.length - 1].classList.add('drop-after');
  }

  clearDropHighlight() {
    for (const cell of this.thead.querySelectorAll('.drop-before, .drop-after')) {
      cell.classList.remove('drop-before', 'drop-after');
    }
  }

  // ---------------------------------------------------------------- Auswahl

  selectionBounds() {
    if (!this.focus || !this.anchor) return null;
    return {
      rowFrom: Math.min(this.focus.row, this.anchor.row),
      rowTo: Math.max(this.focus.row, this.anchor.row),
      posFrom: Math.min(this.focus.pos, this.anchor.pos),
      posTo: Math.max(this.focus.pos, this.anchor.pos)
    };
  }

  onCellMouseDown(event) {
    const cell = event.target.closest('td[data-position]');
    const row = event.target.closest('tr');
    if (!cell || !row || row.dataset.viewIndex == null) return;

    const target = { row: Number(row.dataset.viewIndex), pos: Number(cell.dataset.position) };
    this.focus = target;
    if (!event.shiftKey || !this.anchor) this.anchor = { ...target };

    this.element.focus();
    this.renderRows(true);
    this.updateStatus();
    this.scheduleStats();
    this.refreshValueIfOpen();
  }

  onKeyDown(event) {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const total = this.view.length;
    if (total === 0) return;

    const pageSize = Math.max(1, Math.floor(this.scroller.clientHeight / this.rowHeight) - 1);
    const current = this.focus || { row: 0, pos: 0 };
    let { row, pos } = current;
    let handled = true;

    switch (event.key) {
      case 'ArrowDown': row = Math.min(total - 1, row + 1); break;
      case 'ArrowUp': row = Math.max(0, row - 1); break;
      case 'ArrowRight': pos = Math.min(this.visible.length - 1, pos + 1); break;
      case 'ArrowLeft': pos = Math.max(0, pos - 1); break;
      case 'PageDown': row = Math.min(total - 1, row + pageSize); break;
      case 'PageUp': row = Math.max(0, row - pageSize); break;
      case 'Home':
        if (event.ctrlKey || event.metaKey) row = 0;
        pos = 0;
        break;
      case 'End':
        if (event.ctrlKey || event.metaKey) row = total - 1;
        pos = this.visible.length - 1;
        break;
      case 'Escape': this.hideValue(); handled = false; break;
      default: handled = false;
    }

    // Ein druckbares Zeichen beginnt die Eingabe direkt, wie in einer Tabellenkalkulation.
    if (!handled && !event.ctrlKey && !event.metaKey && !event.altKey &&
        event.key.length === 1 && this.focus) {
      event.preventDefault();
      this.beginEdit(event.key);
      return;
    }

    if (handled) {
      event.preventDefault();
      this.focus = { row: Math.max(0, row), pos: Math.max(0, pos) };
      if (!event.shiftKey || !this.anchor) this.anchor = { ...this.focus };
      this.scrollFocusIntoView();
      this.renderRows(true);
      this.updateStatus();
      this.scheduleStats();
      this.refreshValueIfOpen();
    }
  }

  selectAll() {
    if (this.view.length === 0) return;
    this.anchor = { row: 0, pos: 0 };
    this.focus = { row: this.view.length - 1, pos: this.visible.length - 1 };
    this.renderRows(true);
    this.updateStatus();
    this.scheduleStats();
  }

  scrollFocusIntoView() {
    if (!this.focus) return;

    const top = this.focus.row * this.rowHeight;
    const bottom = top + this.rowHeight;
    const headerHeight = this.thead.offsetHeight;
    if (top < this.scroller.scrollTop) {
      this.scroller.scrollTop = top;
    } else if (bottom > this.scroller.scrollTop + this.scroller.clientHeight - headerHeight) {
      this.scroller.scrollTop = bottom - this.scroller.clientHeight + headerHeight;
    }

    let left = 0;
    for (let position = 0; position < this.focus.pos; position++) {
      left += this.widths[this.visible[position]];
    }
    const right = left + this.widths[this.visible[this.focus.pos]];
    const gutter = this.gutterWidth();
    if (left < this.scroller.scrollLeft) {
      this.scroller.scrollLeft = left;
    } else if (right + gutter > this.scroller.scrollLeft + this.scroller.clientWidth) {
      this.scroller.scrollLeft = right + gutter - this.scroller.clientWidth;
    }
  }

  goToRow(number) {
    if (this.view.length === 0) return;
    const index = Math.min(Math.max(1, number), this.view.length) - 1;
    this.focus = { row: index, pos: this.focus ? this.focus.pos : 0 };
    this.anchor = { ...this.focus };
    this.scroller.scrollTop = Math.max(0, index * this.rowHeight - this.scroller.clientHeight / 2);
    this.renderRows(true);
    this.updateStatus();
  }

  promptGoToRow() {
    this.setMessage('Zu Zeile springen: ');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.classList.add('input-text', 'native-key-bindings', 'csv-dataview-goto');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.goToRow(Number(input.value));
        this.element.focus();
      } else if (event.key === 'Escape') {
        this.updateStatus();
        this.element.focus();
      }
      event.stopPropagation();
    });
    input.addEventListener('blur', () => this.updateStatus());
    this.status.appendChild(input);
    input.focus();
  }


  // ---------------------------------------------------------------- Bearbeiten

  cellElement(row, position) {
    return this.tbody.querySelector(
      `tr[data-view-index="${row}"] td[data-position="${position}"]`
    );
  }

  beginEdit(initial = null) {
    if (this.editing || !this.focus) return;
    if (this.focus.row >= this.view.length) return;

    this.scrollFocusIntoView();
    this.renderRows(true);

    const { row, pos } = this.focus;
    const cell = this.cellElement(row, pos);
    if (!cell) return;

    const column = this.visible[pos];
    const dataRow = this.rows[this.view[row]];
    const original = dataRow[column] == null ? '' : dataRow[column];

    const input = document.createElement('input');
    input.type = 'text';
    input.classList.add('input-text', 'native-key-bindings', 'csv-dataview-cell-editor');
    input.value = initial == null ? original : initial;

    cell.classList.add('editing');
    cell.replaceChildren(input);
    input.focus();
    if (initial == null) input.select();

    this.editing = { input, cell, row, pos, column, dataRow, original };

    input.addEventListener('keydown', (event) => this.onEditorKeyDown(event));
    input.addEventListener('blur', () => this.commitEdit(null));
  }

  onEditorKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit(event.shiftKey ? 'up' : 'down');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.commitEdit(event.shiftKey ? 'left' : 'right');
    }
  }

  commitEdit(move) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;

    const value = editing.input.value;
    if (value !== editing.original) {
      this.applyOperation({
        type: 'cell',
        row: editing.dataRow,
        column: editing.column,
        before: editing.original,
        after: value,
        wasEdited: this.isEdited(editing.dataRow, editing.column)
      });
    }

    this.moveAfterEdit(move);
    this.element.focus();
    this.renderRows(true);
    this.updateStatus();
    this.scheduleStats();
  }

  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.element.focus();
    this.renderRows(true);
  }

  moveAfterEdit(move) {
    if (!move || !this.focus) return;
    let { row, pos } = this.focus;
    if (move === 'down') row = Math.min(this.view.length - 1, row + 1);
    if (move === 'up') row = Math.max(0, row - 1);
    if (move === 'right') pos = Math.min(this.visible.length - 1, pos + 1);
    if (move === 'left') pos = Math.max(0, pos - 1);
    this.focus = { row, pos };
    this.anchor = { row, pos };
    this.scrollFocusIntoView();
  }

  clearSelection() {
    const bounds = this.selectionBounds();
    if (!bounds) return;

    const entries = [];
    for (let i = bounds.rowFrom; i <= bounds.rowTo; i++) {
      const row = this.rows[this.view[i]];
      for (let position = bounds.posFrom; position <= bounds.posTo; position++) {
        const column = this.visible[position];
        const before = row[column] == null ? '' : row[column];
        if (before === '') continue;
        entries.push({ row, column, before, wasEdited: this.isEdited(row, column) });
      }
    }
    if (entries.length === 0) return;
    this.applyOperation({ type: 'cells', entries, after: '' });
    this.renderRows(true);
    this.updateStatus();
  }

  insertRow() {
    const index = this.focus && this.view.length > 0
      ? this.view[this.focus.row] + 1
      : this.rows.length;
    const row = new Array(this.header.length).fill('');
    this.applyOperation({ type: 'insert', index, row });

    const position = this.view.indexOf(index);
    if (position === -1) {
      atom.notifications.addInfo('Zeile eingefügt — der aktive Filter blendet sie aus.');
    } else {
      this.focus = { row: position, pos: this.focus ? this.focus.pos : 0 };
      this.anchor = { ...this.focus };
      this.scrollFocusIntoView();
      this.renderRows(true);
      this.beginEdit();
    }
  }

  deleteSelectedRows() {
    const bounds = this.selectionBounds();
    if (!bounds || this.view.length === 0) return;

    const entries = [];
    for (let i = bounds.rowFrom; i <= bounds.rowTo; i++) {
      const index = this.view[i];
      entries.push({ index, row: this.rows[index] });
    }
    entries.sort((a, b) => a.index - b.index);
    this.applyOperation({ type: 'delete', entries });
    atom.notifications.addSuccess(`${formatCount(entries.length)} Zeilen entfernt (ctrl-z macht das rückgängig).`);
  }

  // ------------------------------------------------------- Änderungen führen

  isEdited(row, column) {
    const columns = this.editedRows.get(row);
    return Boolean(columns && columns.has(column));
  }

  markEdited(row, column, edited) {
    let columns = this.editedRows.get(row);
    if (!columns) {
      if (!edited) return;
      columns = new Set();
      this.editedRows.set(row, columns);
    }
    if (edited) columns.add(column);
    else columns.delete(column);
  }

  applyOperation(operation) {
    const structural = this.performOperation(operation, false);
    this.undoStack.push(operation);
    if (this.undoStack.length > 1000) {
      this.undoStack.shift();
      if (this.savedDepth > 0) this.savedDepth--;
    }
    this.redoStack = [];
    this.afterOperation(structural);
  }

  undo() {
    const operation = this.undoStack.pop();
    if (!operation) return;
    const structural = this.performOperation(operation, true);
    this.redoStack.push(operation);
    this.afterOperation(structural);
  }

  redo() {
    const operation = this.redoStack.pop();
    if (!operation) return;
    const structural = this.performOperation(operation, false);
    this.undoStack.push(operation);
    this.afterOperation(structural);
  }

  performOperation(operation, reverse) {
    switch (operation.type) {
      case 'cell':
        operation.row[operation.column] = reverse ? operation.before : operation.after;
        this.markEdited(operation.row, operation.column, reverse ? operation.wasEdited : true);
        return false;

      case 'cells':
        for (const entry of operation.entries) {
          entry.row[entry.column] = reverse ? entry.before : operation.after;
          this.markEdited(entry.row, entry.column, reverse ? entry.wasEdited : true);
        }
        return false;

      case 'insert':
        if (reverse) this.rows.splice(operation.index, 1);
        else this.rows.splice(operation.index, 0, operation.row);
        return true;

      case 'delete':
        if (reverse) {
          for (const entry of operation.entries) this.rows.splice(entry.index, 0, entry.row);
        } else {
          for (let i = operation.entries.length - 1; i >= 0; i--) {
            this.rows.splice(operation.entries[i].index, 1);
          }
        }
        return true;

      default:
        return false;
    }
  }

  afterOperation(structural) {
    this.setDirty(this.undoStack.length !== this.savedDepth);
    if (structural) this.applyQuery(true);
    else this.renderRows(true);
    this.updateStatus();
  }

  setDirty(dirty) {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    if (this.saveButton) this.saveButton.disabled = !dirty;
    this.element.classList.toggle('csv-dataview-modified', dirty);
    this.emitter.emit('did-change-modified', dirty);
  }

  save() {
    if (!this.filePath) return;
    const delimiter = this.detectedDelimiter || ',';
    const text = csv.toCsv(this.hasHeader ? this.headerRow : null, this.rows, delimiter, {
      lineEnding: this.lineEnding,
      quoteAll: atom.config.get('csv-dataview.quoteAllOnSave')
    });

    try {
      this.suppressReloadUntil = Date.now() + 2000;
      fs.writeFileSync(this.filePath, text + this.lineEnding, 'utf8');
      this.savedDepth = this.undoStack.length;
      this.editedRows = new WeakMap();
      this.setDirty(false);
      this.renderRows(true);
      this.updateStatus();
    } catch (error) {
      atom.notifications.addError(`Speichern fehlgeschlagen: ${error.message}`);
    }
  }

  saveAs(filePath) {
    this.filePath = filePath;
    this.save();
    this.emitter.emit('did-change-title');
  }

  // ------------------------------------------------------- Kopieren, Export

  copySelection(withHeader) {
    const bounds = this.selectionBounds();
    if (!bounds) return;

    const columns = this.visible.slice(bounds.posFrom, bounds.posTo + 1);
    const lines = [];
    if (withHeader) lines.push(columns.map((column) => this.header[column]).join('\t'));

    for (let i = bounds.rowFrom; i <= bounds.rowTo; i++) {
      const row = this.rows[this.view[i]];
      lines.push(columns.map((column) => row[column] || '').join('\t'));
    }

    atom.clipboard.write(lines.join('\n'));
    const cells = (bounds.rowTo - bounds.rowFrom + 1) * columns.length;
    if (cells > 1) atom.notifications.addSuccess(`${formatCount(cells)} Zellen kopiert.`);
  }

  copyVisibleAsCsv() {
    const delimiter = this.detectedDelimiter || ',';
    const columns = this.visible;
    const header = this.hasHeader ? columns.map((column) => this.header[column]) : null;
    const rows = this.view.map((index) => columns.map((column) => this.rows[index][column]));
    atom.clipboard.write(csv.toCsv(header, rows, delimiter));
    atom.notifications.addSuccess(`${formatCount(rows.length)} Zeilen kopiert.`);
  }

  saveFiltered() {
    if (!this.filePath) return;
    const delimiter = this.detectedDelimiter || ',';
    const columns = this.visible;
    const header = this.hasHeader ? columns.map((column) => this.header[column]) : null;
    const rows = this.view.map((index) => columns.map((column) => this.rows[index][column]));

    const directory = path.dirname(this.filePath);
    const extension = path.extname(this.filePath);
    const base = path.basename(this.filePath, extension);
    let target = path.join(directory, `${base}.gefiltert${extension}`);
    let counter = 2;
    while (fs.existsSync(target)) {
      target = path.join(directory, `${base}.gefiltert-${counter}${extension}`);
      counter++;
    }

    try {
      fs.writeFileSync(target, csv.toCsv(header, rows, delimiter) + '\n', 'utf8');
      atom.notifications.addSuccess(
        `${formatCount(rows.length)} Zeilen gespeichert: ${path.basename(target)}`,
        { dismissable: true }
      );
    } catch (error) {
      atom.notifications.addError(`Speichern fehlgeschlagen: ${error.message}`);
    }
  }

  // ------------------------------------------------------------ Wertansicht

  showValue() {
    if (!this.focus) return;
    const column = this.visible[this.focus.pos];
    const row = this.rows[this.view[this.focus.row]];
    if (!row) return;
    const value = row[column] == null ? '' : row[column];

    this.inspector.replaceChildren();
    this.inspector.style.display = '';

    const title = document.createElement('div');
    title.classList.add('csv-dataview-inspector-title');
    title.textContent = `${this.header[column]} · Zeile ${formatCount(this.view[this.focus.row] + 1)}`;
    this.inspector.appendChild(title);

    const body = document.createElement('pre');
    body.classList.add('csv-dataview-inspector-body');
    body.textContent = value;
    this.inspector.appendChild(body);

    const actions = document.createElement('div');
    actions.classList.add('csv-dataview-inspector-actions');
    actions.appendChild(this.button('Wert kopieren', () => {
      atom.clipboard.write(value);
      atom.notifications.addSuccess('Wert kopiert.');
    }));
    actions.appendChild(this.button('Schließen', () => this.hideValue()));
    this.inspector.appendChild(actions);
  }

  refreshValueIfOpen() {
    if (this.inspector.style.display !== 'none') this.showValue();
  }

  hideValue() {
    this.inspector.style.display = 'none';
    this.inspector.replaceChildren();
  }

  // ---------------------------------------------------------------- Statistik

  toggleStats() {
    this.showStats = !this.showStats;
    this.statsToggle.classList.toggle('selected', this.showStats);
    this.statsBar.style.display = this.showStats ? '' : 'none';
    if (this.showStats) this.scheduleStats();
  }

  scheduleStats(force = false) {
    if (!this.showStats) return;
    clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => this.renderStats(force), 150);
  }

  renderStats(force) {
    const bounds = this.selectionBounds();
    const multiCell = bounds &&
      (bounds.rowFrom !== bounds.rowTo || bounds.posFrom !== bounds.posTo);

    let columns;
    let rowFrom;
    let rowTo;
    let label;

    if (multiCell) {
      columns = this.visible.slice(bounds.posFrom, bounds.posTo + 1);
      rowFrom = bounds.rowFrom;
      rowTo = bounds.rowTo;
      label = `Auswahl (${formatCount(rowTo - rowFrom + 1)} × ${columns.length})`;
    } else {
      const column = this.focus ? this.visible[this.focus.pos] : this.visible[0];
      if (column == null) { this.statsBar.replaceChildren(); return; }
      columns = [column];
      rowFrom = 0;
      rowTo = this.view.length - 1;
      label = this.header[column];
    }

    const cells = Math.max(0, (rowTo - rowFrom + 1)) * columns.length;
    this.statsBar.replaceChildren();

    if (cells === 0) {
      this.statsBar.appendChild(document.createTextNode('Keine Daten'));
      return;
    }

    if (cells > STATS_AUTO_LIMIT && !force) {
      this.statsBar.appendChild(document.createTextNode(
        `${formatCount(cells)} Zellen – Auswertung nicht automatisch. `
      ));
      this.statsBar.appendChild(this.button('Berechnen', () => this.renderStats(true)));
      return;
    }

    const iterate = multiCell
      ? rangeValues(this.rows, this.view, rowFrom, rowTo, columns)
      : columnValues(this.rows, this.view, columns[0]);
    const result = summarize(iterate);

    const parts = [
      `${label}:`,
      `${formatCount(result.count)} Werte`,
      `${formatCount(result.empty)} leer`,
      `${formatCount(result.distinct)}${result.distinctCapped ? '+' : ''} eindeutig`
    ];
    if (result.numeric > 0) {
      parts.push(`Summe ${formatNumber(result.sum)}`);
      parts.push(`Ø ${formatNumber(result.average)}`);
      parts.push(`Min ${formatNumber(result.min)}`);
      parts.push(`Max ${formatNumber(result.max)}`);
    }
    this.statsBar.appendChild(document.createTextNode(parts.join('  ·  ')));
  }

  // ------------------------------------------------------------------ Status

  setMessage(text) {
    this.status.replaceChildren();
    if (text) this.status.appendChild(document.createTextNode(text));
  }

  updateStatus() {
    const parts = [];
    if (this.queryError) {
      parts.push(`Filter: ${this.queryError}`);
    } else if (this.view.length === this.rows.length) {
      parts.push(`${formatCount(this.rows.length)} Zeilen`);
    } else {
      parts.push(`${formatCount(this.view.length)} von ${formatCount(this.rows.length)} Zeilen`);
    }

    const hiddenCount = this.hidden.size;
    parts.push(hiddenCount
      ? `${this.visible.length} von ${this.header.length} Spalten`
      : `${this.header.length} Spalten`);

    if (this.sorts.length === 1) {
      parts.push(`sortiert nach ${this.header[this.sorts[0].column]} ${arrow(this.sorts[0].direction)}`);
    } else if (this.sorts.length > 1) {
      parts.push('sortiert nach ' + this.sorts
        .map((sort) => `${this.header[sort.column]} ${arrow(sort.direction)}`)
        .join(', '));
    }

    parts.push(`Trennzeichen ${describeDelimiter(this.detectedDelimiter)}`);
    if (this.dirty) parts.push('ungespeicherte Änderungen');
    if (this.truncated) parts.push('gekürzt (maxRows erreicht)');

    const bounds = this.selectionBounds();
    if (bounds) {
      const rowCount = bounds.rowTo - bounds.rowFrom + 1;
      const columnCount = bounds.posTo - bounds.posFrom + 1;
      if (rowCount === 1 && columnCount === 1) {
        parts.push(`Zeile ${formatCount(this.view[bounds.rowFrom] + 1)}, ${this.header[this.visible[bounds.posFrom]]}`);
      } else {
        parts.push(`Auswahl ${formatCount(rowCount)} × ${columnCount}`);
      }
    }

    this.status.classList.toggle('csv-dataview-status-error', Boolean(this.queryError));
    this.status.replaceChildren();
    this.status.appendChild(document.createTextNode(parts.join('  ·  ')));

    if (this.hidden.size > 0) {
      this.status.appendChild(this.button('Spalten einblenden', () => this.showAllColumns()));
    }
  }
}

function spacer(height, columnCount) {
  const tr = document.createElement('tr');
  tr.classList.add('csv-dataview-spacer');
  tr.style.height = `${Math.max(0, height)}px`;
  const td = document.createElement('td');
  td.colSpan = columnCount;
  tr.appendChild(td);
  return tr;
}

function formatCount(value) {
  return Number(value).toLocaleString('de-DE');
}

function formatNumber(value) {
  if (value == null) return '–';
  return Number.isInteger(value)
    ? value.toLocaleString('de-DE')
    : value.toLocaleString('de-DE', { maximumFractionDigits: 4 });
}

function arrow(direction) {
  return direction === 'desc' ? '▼' : '▲';
}

function describeDelimiter(delimiter) {
  if (delimiter === '\t') return 'Tab';
  if (delimiter === ';') return 'Semikolon';
  if (delimiter === ',') return 'Komma';
  if (delimiter === '|') return 'Pipe';
  return delimiter || '?';
}

module.exports = CsvDataView;
