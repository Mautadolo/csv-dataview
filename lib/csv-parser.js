'use strict';

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      count++;
    }
  }
  return count;
}

// Wählt das Trennzeichen, das über die ersten Zeilen am gleichmäßigsten auftritt.
function detectDelimiter(text, fallback = ',') {
  const sample = text.split(/\r?\n/).slice(0, 25).filter((l) => l.trim().length > 0);
  if (sample.length === 0) return fallback;

  let best = fallback;
  let bestScore = 0;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));
    const first = counts[0];
    if (!first) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = first * consistent * consistent;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/*
 * RFC-4180-Parser als Zustandsautomat: doppelte Anführungszeichen, eingebettete
 * Zeilenumbrüche, CRLF. Der Zustand überlebt Chunk-Grenzen, damit große Dateien
 * stückweise eingelesen werden können.
 */
function createIncrementalParser(delimiter) {
  let row = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let dirty = false;
  let atStart = true;
  let pendingQuote = false; // Chunk endete auf " – Escape oder Feldende?

  function write(chunk, emit) {
    if (atStart) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); // BOM
      atStart = false;
    }

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') { field += '"'; continue; } // escaptes Anführungszeichen
        inQuotes = false;
      }

      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') { field += '"'; i++; continue; }
            inQuotes = false;
            continue;
          }
          pendingQuote = true;
          continue;
        }
        field += ch;
        continue;
      }

      if (ch === '"' && field === '' && !quotedField) {
        inQuotes = true;
        quotedField = true;
        dirty = true;
        continue;
      }
      if (ch === delimiter) {
        row.push(field);
        field = '';
        quotedField = false;
        dirty = true;
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\n') {
        row.push(field);
        if (dirty || row.length > 1) emit(row);
        row = [];
        field = '';
        quotedField = false;
        dirty = false;
        continue;
      }
      field += ch;
      dirty = true;
    }
  }

  function end(emit) {
    if (pendingQuote) { pendingQuote = false; inQuotes = false; }
    if (dirty || field !== '') {
      row.push(field);
      emit(row);
      row = [];
      field = '';
      dirty = false;
    }
  }

  return { write, end };
}

function parse(text, delimiter) {
  const rows = [];
  const parser = createIncrementalParser(delimiter);
  const emit = (row) => rows.push(row);
  parser.write(text, emit);
  parser.end(emit);
  return rows;
}

function padRows(rows, width) {
  for (const row of rows) {
    while (row.length < width) row.push('');
    if (row.length > width) row.length = width;
  }
  return rows;
}

// Erkennt sowohl 1.234,56 als auch 1,234.56 sowie einfache Währungs-/Prozentzeichen.
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;

  let s = String(value).trim();
  if (!s) return null;

  s = s.replace(/[\s\u00a0'’]/g, '').replace(/[€$£¥%]/g, '');
  if (!/^[-+]?[\d.,]+$/.test(s)) return null;

  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  } else if (/^[-+]?\d+,\d+$/.test(s)) {
    s = s.replace(',', '.');
  } else if (s.split(',').length > 2 || s.split('.').length > 2) {
    return null;
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2})(:(\d{2}))?)?/;
const DE_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

function parseDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m = ISO_DATE.exec(s);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], m[5] ? +m[5] : 0, m[6] ? +m[6] : 0, m[8] ? +m[8] : 0);
  }
  m = DE_DATE.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return Date.UTC(year, +m[2] - 1, +m[1]);
  }
  m = US_DATE.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return Date.UTC(year, +m[1] - 1, +m[2]);
  }
  return null;
}

// 'number' | 'date' | 'text' pro Spalte, ermittelt an einer Stichprobe.
function inferTypes(rows, width, sampleSize = 250) {
  const types = new Array(width).fill('text');
  const limit = Math.min(rows.length, sampleSize);

  for (let c = 0; c < width; c++) {
    let seen = 0;
    let numbers = 0;
    let dates = 0;

    for (let r = 0; r < limit; r++) {
      const raw = rows[r][c];
      if (raw == null || raw === '') continue;
      seen++;
      if (parseNumber(raw) !== null) numbers++;
      else if (parseDate(raw) !== null) dates++;
    }

    if (seen === 0) continue;
    if (numbers / seen >= 0.9) types[c] = 'number';
    else if (dates / seen >= 0.9) types[c] = 'date';
  }
  return types;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareValues(a, b, type) {
  const emptyA = a == null || a === '';
  const emptyB = b == null || b === '';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1; // leere Werte immer ans Ende
  if (emptyB) return -1;

  if (type === 'number') {
    const na = parseNumber(a);
    const nb = parseNumber(b);
    if (na !== null && nb !== null) return na - nb;
  } else if (type === 'date') {
    const da = parseDate(a);
    const db = parseDate(b);
    if (da !== null && db !== null) return da - db;
  }
  return collator.compare(String(a), String(b));
}

function quote(value, delimiter, quoteAll) {
  const s = value == null ? '' : String(value);
  if (quoteAll) return '"' + s.replace(/"/g, '""') + '"';
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(header, rows, delimiter, options = {}) {
  const lineEnding = options.lineEnding || '\n';
  const quoteAll = Boolean(options.quoteAll);
  const lines = [];
  if (header) lines.push(header.map((h) => quote(h, delimiter, quoteAll)).join(delimiter));
  for (const row of rows) lines.push(row.map((v) => quote(v, delimiter, quoteAll)).join(delimiter));
  return lines.join(lineEnding);
}

module.exports = {
  CANDIDATE_DELIMITERS,
  detectDelimiter,
  createIncrementalParser,
  parse,
  padRows,
  parseNumber,
  parseDate,
  inferTypes,
  compareValues,
  toCsv
};
