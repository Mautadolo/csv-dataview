'use strict';

const { parseNumber } = require('./csv-parser');

const DISTINCT_LIMIT = 50000;

/**
 * @param {function(function(string): void): void} iterate ruft den Callback für jeden Wert auf
 */
function summarize(iterate) {
  let count = 0;
  let empty = 0;
  let numeric = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const distinct = new Set();
  let distinctCapped = false;

  iterate((raw) => {
    count++;
    const value = raw == null ? '' : String(raw);
    if (value.trim() === '') {
      empty++;
      return;
    }

    if (!distinctCapped) {
      distinct.add(value);
      if (distinct.size >= DISTINCT_LIMIT) distinctCapped = true;
    }

    const number = parseNumber(value);
    if (number !== null) {
      numeric++;
      sum += number;
      if (number < min) min = number;
      if (number > max) max = number;
    }
  });

  return {
    count,
    empty,
    filled: count - empty,
    distinct: distinct.size,
    distinctCapped,
    numeric,
    sum: numeric ? sum : null,
    min: numeric ? min : null,
    max: numeric ? max : null,
    average: numeric ? sum / numeric : null
  };
}

function columnValues(rows, view, column) {
  return (callback) => {
    for (let i = 0; i < view.length; i++) callback(rows[view[i]][column]);
  };
}

function rangeValues(rows, view, rowFrom, rowTo, columns) {
  return (callback) => {
    for (let i = rowFrom; i <= rowTo; i++) {
      const row = rows[view[i]];
      if (!row) continue;
      for (const column of columns) callback(row[column]);
    }
  };
}

module.exports = { summarize, columnValues, rangeValues };
