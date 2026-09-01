'use strict';

const { parseNumber, parseDate } = require('./csv-parser');

const OPERATOR = /^(>=|<=|!=|<>|==|=|>|<)\s*([\s\S]*)$/;

/*
 * Die kleinen Felder unter den Spaltenköpfen. Ohne Operator wird als Teilstring
 * gesucht, sonst:
 *
 *   > 100        <= 5        != offen
 *   Ber*         Platzhalter
 *   /^ab.*z$/    regulärer Ausdruck
 *   empty        !empty
 */
function compileColumnFilter(text, column, type) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (lower === 'empty' || lower === 'leer') {
    return (row) => String(row[column] || '').trim() === '';
  }
  if (lower === '!empty' || lower === '!leer') {
    return (row) => String(row[column] || '').trim() !== '';
  }

  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    try {
      const regex = new RegExp(raw.slice(1, -1), 'i');
      return (row) => regex.test(row[column] || '');
    } catch (error) {
      return null; // unfertige Eingabe: noch nicht filtern
    }
  }

  const match = OPERATOR.exec(raw);
  if (match) {
    const operator = match[1];
    const operand = match[2].trim();
    if (!operand) return null;
    return comparison(operator, operand, column, type);
  }

  if (raw.includes('*')) {
    const pattern = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${pattern}$`, 'i');
    return (row) => regex.test(row[column] || '');
  }

  const needle = lower;
  return (row) => String(row[column] || '').toLowerCase().includes(needle);
}

function comparison(operator, operand, column, type) {
  const operandNumber = parseNumber(operand);
  const operandDate = type === 'date' ? parseDate(operand) : null;

  const valueOf = (row) => {
    const raw = row[column];
    if (operandNumber !== null) {
      const number = parseNumber(raw);
      if (number !== null) return { number };
    }
    if (operandDate !== null) {
      const date = parseDate(raw);
      if (date !== null) return { number: date };
    }
    return { text: String(raw == null ? '' : raw) };
  };

  const target = operandDate !== null ? operandDate : operandNumber;
  const operandText = operand.toLowerCase();

  return (row) => {
    const value = valueOf(row);
    let result;
    if (value.number != null && target !== null) {
      result = value.number < target ? -1 : value.number > target ? 1 : 0;
    } else {
      const text = (value.text != null ? value.text : String(value.number)).toLowerCase();
      result = text < operandText ? -1 : text > operandText ? 1 : 0;
    }

    switch (operator) {
      case '>': return result > 0;
      case '>=': return result >= 0;
      case '<': return result < 0;
      case '<=': return result <= 0;
      case '!=':
      case '<>': return result !== 0;
      default: return result === 0;
    }
  };
}

module.exports = { compileColumnFilter };
