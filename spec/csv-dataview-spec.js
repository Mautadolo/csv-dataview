'use strict';

const csv = require('../lib/csv-parser');
const { parseQuery } = require('../lib/query');

const SAMPLE = 'name;betrag;datum\n"Müller, GmbH";1.234,56;01.02.2024\nSchmidt;99;2024-03-05\n"Zeile\nmit Umbruch";5;\n';

describe('csv-parser', () => {
  it('erkennt das Trennzeichen', () => {
    expect(csv.detectDelimiter(SAMPLE)).toBe(';');
    expect(csv.detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(csv.detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
  });

  it('liest Anführungszeichen und eingebettete Umbrüche', () => {
    const rows = csv.parse(SAMPLE, ';');
    expect(rows.length).toBe(4);
    expect(rows[1][0]).toBe('Müller, GmbH');
    expect(rows[3][0]).toBe('Zeile\nmit Umbruch');
  });

  it('liefert über Chunk-Grenzen dasselbe Ergebnis', () => {
    const parser = csv.createIncrementalParser(';');
    const rows = [];
    const emit = (row) => rows.push(row);
    for (let i = 0; i < SAMPLE.length; i += 3) {
      parser.write(SAMPLE.slice(i, i + 3), emit);
    }
    parser.end(emit);
    expect(rows).toEqual(csv.parse(SAMPLE, ';'));
  });

  it('versteht deutsche und englische Zahlenformate', () => {
    expect(csv.parseNumber('1.234,56')).toBe(1234.56);
    expect(csv.parseNumber('1,234.56')).toBe(1234.56);
    expect(csv.parseNumber('42 €')).toBe(42);
    expect(csv.parseNumber('n/a')).toBe(null);
  });

  it('leitet Spaltentypen ab', () => {
    const rows = csv.parse(SAMPLE, ';');
    expect(csv.inferTypes(rows.slice(1), 3)).toEqual(['text', 'number', 'date']);
  });
});

describe('query', () => {
  const rows = csv.parse(SAMPLE, ';');
  const header = rows[0];
  const data = rows.slice(1);

  const count = (source) => {
    const result = parseQuery(source, header);
    expect(result.ok).toBe(true);
    return data.filter(result.predicate).length;
  };

  it('vergleicht Zahlen numerisch', () => {
    expect(count('betrag > 50')).toBe(2);
    expect(count('betrag <= 99')).toBe(2);
  });

  it('verknüpft mit and/or/not', () => {
    expect(count('betrag > 50 and name contains schmidt')).toBe(1);
    expect(count('not (betrag > 50)')).toBe(1);
  });

  it('sucht ohne Operator im ganzen Datensatz', () => {
    expect(count('umbruch')).toBe(1);
  });

  it('meldet Syntaxfehler statt zu werfen', () => {
    const result = parseQuery('betrag >', header);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

describe('column-filter', () => {
  const { compileColumnFilter } = require('../lib/column-filter');
  const rows = [['Dresden', '563000'], ['Leipzig', '616000'], ['Bautzen', ''], ['Bern', '134000']];
  const run = (text, column, type) => {
    const predicate = compileColumnFilter(text, column, type);
    return rows.filter(predicate).map((row) => row[0]);
  };

  it('sucht ohne Operator als Teilstring', () => {
    expect(run('be', 0, 'text')).toEqual(['Bautzen', 'Bern']);
  });

  it('vergleicht mit Operator numerisch', () => {
    expect(run('> 500000', 1, 'number')).toEqual(['Dresden', 'Leipzig']);
    expect(run('<= 134000', 1, 'number')).toEqual(['Bern']);
  });

  it('versteht Platzhalter und reguläre Ausdrücke', () => {
    expect(run('B*n', 0, 'text')).toEqual(['Bautzen', 'Bern']);
    expect(run('/^le/', 0, 'text')).toEqual(['Leipzig']);
  });

  it('findet leere Zellen', () => {
    expect(run('empty', 1, 'number')).toEqual(['Bautzen']);
    expect(run('!empty', 1, 'number')).toEqual(['Dresden', 'Leipzig', 'Bern']);
  });

  it('ignoriert unfertige Eingaben', () => {
    expect(compileColumnFilter('   ', 0, 'text')).toBe(null);
    expect(compileColumnFilter('>', 1, 'number')).toBe(null);
  });
});

describe('stats', () => {
  const { summarize, columnValues } = require('../lib/stats');
  const rows = [['5'], ['7'], [''], ['1.234,56']];

  it('fasst Werte zusammen', () => {
    const result = summarize(columnValues(rows, [0, 1, 2, 3], 0));
    expect(result.count).toBe(4);
    expect(result.empty).toBe(1);
    expect(result.numeric).toBe(3);
    expect(result.sum).toBeCloseTo(1246.56, 2);
    expect(result.min).toBe(5);
    expect(result.max).toBeCloseTo(1234.56, 2);
  });
});

describe('toCsv', () => {
  it('setzt Anführungszeichen nur wo nötig', () => {
    const rows = [['Halle; Saale', 'ok'], ['mit "Zitat"', 'ok']];
    expect(csv.toCsv(['a', 'b'], rows, ';', { lineEnding: '\r\n' })).toBe(
      'a;b\r\n"Halle; Saale";ok\r\n"mit ""Zitat""";ok'
    );
  });

  it('kann alles quoten', () => {
    expect(csv.toCsv(null, [['x', 'y']], ',', { quoteAll: true })).toBe('"x","y"');
  });
});
