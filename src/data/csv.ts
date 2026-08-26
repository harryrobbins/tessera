import { Dataset, Column, numeric, category, text } from './columnar';

/**
 * Single-pass CSV parser (RFC4180-ish): quoted fields, doubled-quote escapes,
 * CRLF/LF, and a trailing newline. Scans by charCodeAt and slices fields
 * directly out of the source string — no regex splitting, no intermediate
 * per-cell structures.
 */
export function parseCsv(input: string): { header: string[]; rows: string[][] } {
  const n = input.length;
  const rows: string[][] = [];
  let i = 0;

  while (i < n) {
    const row: string[] = [];
    let rowDone = false;
    while (!rowDone) {
      let field: string;
      if (input.charCodeAt(i) === 34 /* " */) {
        i++;
        const start = i;
        let escaped = false;
        while (i < n) {
          if (input.charCodeAt(i) === 34) {
            if (input.charCodeAt(i + 1) === 34) {
              escaped = true;
              i += 2;
              continue;
            }
            break;
          }
          i++;
        }
        field = escaped ? unescapeQuotes(input, start, i) : input.slice(start, i);
        i++; // skip closing quote
      } else {
        const start = i;
        while (i < n) {
          const c = input.charCodeAt(i);
          if (c === 44 /* , */ || c === 13 /* \r */ || c === 10 /* \n */) break;
          i++;
        }
        field = input.slice(start, i);
      }
      row.push(field);

      const c = input.charCodeAt(i);
      if (c === 44) {
        i++; // more fields follow
      } else if (c === 13) {
        i++;
        if (input.charCodeAt(i) === 10) i++;
        rowDone = true;
      } else if (c === 10) {
        i++;
        rowDone = true;
      } else {
        rowDone = true; // EOF
      }
    }
    rows.push(row);
  }

  const header = rows.length > 0 ? rows.shift()! : [];
  return { header, rows };
}

/** Collapse `""` escapes within a quoted field's [start,end) span. */
function unescapeQuotes(src: string, start: number, end: number): string {
  let out = '';
  let chunkStart = start;
  for (let i = start; i < end; i++) {
    if (src.charCodeAt(i) === 34 && src.charCodeAt(i + 1) === 34) {
      out += src.slice(chunkStart, i + 1);
      i++; // skip the paired quote
      chunkStart = i + 1;
    }
  }
  return out + src.slice(chunkStart, end);
}

/**
 * Infer a Dataset from parsed CSV rows: numeric if >=90% of non-empty values
 * parse as finite numbers, categorical if the distinct count is small
 * relative to the row count, otherwise free text.
 */
export function inferDataset(
  name: string,
  header: string[],
  rows: string[][],
  opts?: { labelColumn?: string }
): Dataset {
  const n = rows.length;
  const categoryLimit = Math.max(40, n * 0.02);
  const columns: Record<string, Column> = {};
  const categoricalNames: string[] = [];
  const numericNames: string[] = [];
  let firstTextColumn: string | undefined;

  for (let c = 0; c < header.length; c++) {
    const colName = header[c];
    const values = new Array<string>(n);
    let nonEmpty = 0;
    let numericOk = 0;
    const distinct = new Set<string>();
    for (let r = 0; r < n; r++) {
      const v = rows[r][c] ?? '';
      values[r] = v;
      if (v === '') continue;
      nonEmpty++;
      distinct.add(v);
      if (Number.isFinite(Number(v))) numericOk++;
    }

    if (nonEmpty > 0 && numericOk / nonEmpty >= 0.9) {
      const nums = new Float32Array(n);
      for (let r = 0; r < n; r++) {
        nums[r] = values[r] === '' ? NaN : Number(values[r]);
      }
      columns[colName] = numeric(colName, nums);
      numericNames.push(colName);
    } else if (distinct.size <= categoryLimit) {
      columns[colName] = category(colName, values);
      categoricalNames.push(colName);
    } else {
      columns[colName] = text(colName, values);
      if (firstTextColumn === undefined) firstTextColumn = colName;
    }
  }

  return {
    name,
    n,
    columns,
    labelColumn: opts?.labelColumn ?? firstTextColumn ?? header[0] ?? '',
    facets: [...categoricalNames, ...numericNames],
  };
}
