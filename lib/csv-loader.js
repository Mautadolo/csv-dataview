'use strict';

const fs = require('fs');
const csv = require('./csv-parser');

const CHUNK_SIZE = 1 << 20; // 1 MB
const PROGRESS_INTERVAL = 120; // ms

/**
 * Liest eine CSV-Datei stückweise ein, ohne den UI-Thread länger als eine
 * Chunk-Verarbeitung zu blockieren. Rückgabe: {promise, cancel}.
 *
 * options:
 *   delimiter   festes Trennzeichen oder null für automatische Erkennung
 *   maxRows     harte Obergrenze (0 = unbegrenzt)
 *   onProgress  ({rows, bytes, total, delimiter}) => void
 */
function loadCsvFile(filePath, options = {}) {
  const { delimiter: fixedDelimiter = null, maxRows = 0, onProgress } = options;

  let cancelled = false;
  let stream = null;

  const promise = new Promise((resolve, reject) => {
    let total = 0;
    try {
      total = fs.statSync(filePath).size;
    } catch (error) {
      reject(error);
      return;
    }

    const rows = [];
    let delimiter = fixedDelimiter;
    let parser = delimiter ? csv.createIncrementalParser(delimiter) : null;
    let sniffBuffer = '';
    let bytes = 0;
    let width = 0;
    let truncated = false;
    let lastProgress = 0;
    let lineEnding = null;

    const emit = (row) => {
      if (maxRows && rows.length >= maxRows) { truncated = true; return; }
      if (row.length > width) width = row.length;
      rows.push(row);
    };

    stream = fs.createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: CHUNK_SIZE
    });

    stream.on('data', (chunk) => {
      if (cancelled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');

      if (lineEnding === null) {
        const index = chunk.indexOf('\n');
        if (index > 0) lineEnding = chunk[index - 1] === '\r' ? '\r\n' : '\n';
      }

      try {
        // Trennzeichen erst raten, wenn genug Text da ist.
        if (!parser) {
          sniffBuffer += chunk;
          if (sniffBuffer.length < 64 * 1024 && bytes < total) return;
          delimiter = csv.detectDelimiter(sniffBuffer);
          parser = csv.createIncrementalParser(delimiter);
          parser.write(sniffBuffer, emit);
          sniffBuffer = '';
        } else {
          parser.write(chunk, emit);
        }
      } catch (error) {
        stream.destroy();
        reject(error);
        return;
      }

      if (truncated) {
        stream.destroy();
        finish();
        return;
      }

      const now = Date.now();
      if (onProgress && now - lastProgress > PROGRESS_INTERVAL) {
        lastProgress = now;
        onProgress({ rows: rows.length, bytes, total, delimiter });
      }
    });

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (cancelled) { resolve(null); return; }

      try {
        if (!parser) {
          delimiter = csv.detectDelimiter(sniffBuffer);
          parser = csv.createIncrementalParser(delimiter);
          parser.write(sniffBuffer, emit);
        }
        parser.end(emit);
      } catch (error) {
        reject(error);
        return;
      }

      if (width === 0 && rows.length) width = rows[0].length;
      csv.padRows(rows, width);
      resolve({
        rows,
        width,
        delimiter: delimiter || ',',
        lineEnding: lineEnding || '\n',
        bytes: total,
        truncated
      });
    }

    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (error) => {
      if (!cancelled) reject(error);
      else resolve(null);
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      if (stream) stream.destroy();
    }
  };
}

module.exports = { loadCsvFile };
