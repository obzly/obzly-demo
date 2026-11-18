// Test helper: a stand-in for DuckDB-WASM (tests have no Web Worker). The
// table's DROP / CREATE succeed and the logs file it registers is kept; any
// other statement is recorded and answers with the result set by
// setSqlResult. Use it with
//   vi.mock('../lib/duckdb', async () => (await import('./sql.testkit')).fakeDuckDB);
import type { ArrowTable, DuckConnection, DuckDatabase } from '../lib/duckdb';

export interface FakeResult {
  /** Column names, with an Arrow-like type name ("Utf8" when left out). */
  columns: (string | { name: string; type: string })[];
  rows: unknown[][];
}

export const fakeSql = {
  /** The statements run against the logs table, oldest first. */
  statements: [] as string[],
  /** Timestamps (epoch ms) of the logs the last table was built from. */
  tableTimes: [] as number[],
  next: { columns: [], rows: [] } as FakeResult | Error,
};

export function setSqlResult(result: FakeResult | Error) {
  fakeSql.next = result;
}

export function resetFakeSql() {
  fakeSql.statements = [];
  fakeSql.tableTimes = [];
  fakeSql.next = { columns: [], rows: [] };
}

function table({ columns, rows }: FakeResult): ArrowTable {
  const fields = columns.map((c) => (typeof c === 'string' ? { name: c, type: 'Utf8' } : c));
  return {
    numRows: rows.length,
    schema: { fields },
    getChild: (name) => {
      const index = fields.findIndex((field) => field.name === name);
      return index < 0 ? null : { get: (row) => rows[row]?.[index] };
    },
  };
}

const db: DuckDatabase = {
  async registerFileText(_name, text) {
    fakeSql.tableTimes = text
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { ts: number }).ts);
  },
  async dropFile() {},
};

const conn: DuckConnection = {
  async query(sql) {
    if (/^\s*(DROP|CREATE)\b/i.test(sql)) return table({ columns: [], rows: [] });
    fakeSql.statements.push(sql);
    if (fakeSql.next instanceof Error) throw fakeSql.next;
    return table(fakeSql.next);
  },
};

export const fakeDuckDB = {
  startDuckDB: async () => ({ db, conn }),
};
