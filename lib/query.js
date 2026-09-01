'use strict';

const { parseNumber, parseDate } = require('./csv-parser');

/*
 * Kleine Filtersprache:
 *
 *   umsatz > 1000 and land == "DE"
 *   [Erste Spalte] contains berlin or status != offen
 *   not (typ == a) and datum >= 2024-01-01
 *   berlin                     -> Volltextsuche über die ganze Zeile
 *   name == "Ber*"             -> * ist ein Platzhalter
 *   kommentar is empty
 *
 * Operatoren: == = != <> < <= > >= ~ =~ contains startswith endswith matches
 * Verknüpfung: and or not && || ! ( )
 */

const KEYWORDS = new Set([
  'and', 'or', 'not', 'contains', 'startswith', 'endswith', 'matches', 'is', 'empty'
]);

const TWO_CHAR_OPS = new Set(['>=', '<=', '!=', '==', '<>', '&&', '||', '=~']);
const COMPARE_OPS = new Set(['<', '>', '<=', '>=', '=', '==', '!=', '<>', '=~']);
const WORD_OPS = new Set(['contains', 'startswith', 'endswith', 'matches']);

function tokenize(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
        value += src[j];
        j++;
      }
      if (j >= src.length) throw new Error('Anführungszeichen nicht geschlossen');
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }

    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end === -1) throw new Error('Fehlende ]');
      tokens.push({ type: 'name', value: src.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    const two = src.substr(i, 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two === '&&' ? 'and' : two === '||' ? 'or' : two });
      if (two === '&&' || two === '||') tokens[tokens.length - 1].type = 'keyword';
      i += 2;
      continue;
    }

    if (ch === '~') { tokens.push({ type: 'op', value: '=~' }); i++; continue; }
    if (ch === '!') { tokens.push({ type: 'keyword', value: 'not' }); i++; continue; }
    if (ch === '<' || ch === '>' || ch === '=') { tokens.push({ type: 'op', value: ch }); i++; continue; }

    let j = i;
    while (j < src.length && !/[\s()<>=!~"'[\]]/.test(src[j])) j++;
    if (j === i) throw new Error(`Unerwartetes Zeichen: ${ch}`);

    const word = src.slice(i, j);
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower)) tokens.push({ type: 'keyword', value: lower });
    else tokens.push({ type: 'word', value: word });
    i = j;
  }

  return tokens;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '\u0000' : '\\' + m));
  return new RegExp('^' + escaped.replace(/\u0000/g, '.*') + '$', 'i');
}

function parseTokens(tokens, columnIndex) {
  let pos = 0;

  const peek = () => tokens[pos];
  const isKeyword = (v) => { const t = peek(); return t && t.type === 'keyword' && t.value === v; };
  const isParen = (v) => { const t = peek(); return t && t.type === 'paren' && t.value === v; };

  function expectParen() {
    if (!isParen(')')) throw new Error('Fehlende )');
    pos++;
  }

  function parseOr() {
    let node = parseAnd();
    while (isKeyword('or')) {
      pos++;
      node = { t: 'or', l: node, r: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseNot();
    while (isKeyword('and')) {
      pos++;
      node = { t: 'and', l: node, r: parseNot() };
    }
    return node;
  }

  function parseNot() {
    if (isKeyword('not')) {
      pos++;
      return { t: 'not', e: parseNot() };
    }
    return parseComparison();
  }

  function parseComparison() {
    if (isParen('(')) {
      pos++;
      const node = parseOr();
      expectParen();
      return node;
    }

    const left = parseOperand();
    const t = peek();

    if (t && ((t.type === 'op' && COMPARE_OPS.has(t.value)) ||
              (t.type === 'keyword' && WORD_OPS.has(t.value)))) {
      pos++;
      return { t: 'cmp', op: t.value, l: left, r: parseOperand() };
    }

    if (isKeyword('is')) {
      pos++;
      let negate = false;
      if (isKeyword('not')) { negate = true; pos++; }
      if (!isKeyword('empty')) throw new Error('Nach "is" wird "empty" erwartet');
      pos++;
      return { t: 'empty', e: left, negate };
    }

    return { t: 'bare', e: left };
  }

  function parseOperand() {
    const t = peek();
    if (!t) throw new Error('Ausdruck endet unerwartet');

    if (t.type === 'string') { pos++; return { t: 'literal', v: t.value }; }
    if (t.type === 'name') { pos++; return operandFor(t.value, true); }
    if (t.type === 'word') { pos++; return operandFor(t.value, false); }
    if (t.type === 'paren' && t.value === '(') {
      pos++;
      const node = parseOr();
      expectParen();
      return node;
    }
    throw new Error(`Unerwartet: ${t.value}`);
  }

  // Ein Wort ist eine Spalte, wenn es eine gibt – sonst ein Literal.
  function operandFor(word, strict) {
    const idx = columnIndex.get(word.trim().toLowerCase());
    if (idx != null) return { t: 'column', i: idx, name: word };
    if (strict) throw new Error(`Unbekannte Spalte: ${word}`);
    return { t: 'literal', v: word };
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new Error(`Unerwartet: ${tokens[pos].value}`);
  return ast;
}

function getter(node) {
  if (node.t === 'column') {
    const i = node.i;
    return (row) => (row[i] == null ? '' : row[i]);
  }
  if (node.t === 'literal') {
    const v = node.v;
    return () => v;
  }
  throw new Error('Hier wird ein Wert oder eine Spalte erwartet');
}

function looseEquals(a, b) {
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function relational(a, b, cmp) {
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na !== null && nb !== null) return cmp(na, nb);

  const da = parseDate(a);
  const db = parseDate(b);
  if (da !== null && db !== null) return cmp(da, db);

  return cmp(String(a).toLowerCase().localeCompare(String(b).toLowerCase()), 0);
}

function build(node) {
  switch (node.t) {
    case 'or': {
      const l = build(node.l);
      const r = build(node.r);
      return (row) => l(row) || r(row);
    }
    case 'and': {
      const l = build(node.l);
      const r = build(node.r);
      return (row) => l(row) && r(row);
    }
    case 'not': {
      const e = build(node.e);
      return (row) => !e(row);
    }
    case 'empty': {
      const get = getter(node.e);
      return node.negate
        ? (row) => String(get(row)).trim() !== ''
        : (row) => String(get(row)).trim() === '';
    }
    case 'bare': {
      if (node.e.t === 'column') {
        const get = getter(node.e);
        return (row) => String(get(row)).trim() !== '';
      }
      const needle = String(node.e.v).toLowerCase();
      return (row) => row.some((cell) => cell != null && String(cell).toLowerCase().includes(needle));
    }
    case 'cmp': {
      const left = getter(node.l);
      const right = getter(node.r);
      const op = node.op;

      if (op === '==' || op === '=') {
        const literal = node.r.t === 'literal' ? String(node.r.v) : null;
        if (literal !== null && literal.includes('*')) {
          const re = globToRegExp(literal);
          return (row) => re.test(String(left(row)));
        }
        return (row) => looseEquals(left(row), right(row));
      }
      if (op === '!=' || op === '<>') {
        return (row) => !looseEquals(left(row), right(row));
      }
      if (op === '<') return (row) => relational(left(row), right(row), (a, b) => a < b);
      if (op === '<=') return (row) => relational(left(row), right(row), (a, b) => a <= b);
      if (op === '>') return (row) => relational(left(row), right(row), (a, b) => a > b);
      if (op === '>=') return (row) => relational(left(row), right(row), (a, b) => a >= b);

      if (op === 'contains') {
        return (row) => String(left(row)).toLowerCase().includes(String(right(row)).toLowerCase());
      }
      if (op === 'startswith') {
        return (row) => String(left(row)).toLowerCase().startsWith(String(right(row)).toLowerCase());
      }
      if (op === 'endswith') {
        return (row) => String(left(row)).toLowerCase().endsWith(String(right(row)).toLowerCase());
      }
      if (op === '=~' || op === 'matches') {
        let re;
        if (node.r.t === 'literal') {
          re = new RegExp(String(node.r.v), 'i');
          return (row) => re.test(String(left(row)));
        }
        return (row) => {
          try {
            return new RegExp(String(right(row)), 'i').test(String(left(row)));
          } catch (e) {
            return false;
          }
        };
      }
      throw new Error(`Unbekannter Operator: ${op}`);
    }
    default:
      throw new Error('Ausdruck kann nicht ausgewertet werden');
  }
}

/**
 * @param {string} source
 * @param {string[]} header
 * @returns {{ok: boolean, predicate?: function(string[]): boolean, error?: string}}
 */
function parseQuery(source, header) {
  const columnIndex = new Map();
  header.forEach((name, i) => {
    const key = String(name).trim().toLowerCase();
    if (key && !columnIndex.has(key)) columnIndex.set(key, i);
    columnIndex.set(`$${i + 1}`, i); // $1, $2 … als Fallback
  });

  try {
    const tokens = tokenize(source);
    if (tokens.length === 0) return { ok: true, predicate: null };
    const ast = parseTokens(tokens, columnIndex);
    return { ok: true, predicate: build(ast) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { parseQuery, tokenize };
