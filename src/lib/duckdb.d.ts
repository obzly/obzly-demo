// The part of DuckDB-WASM's API the demo's SQL mode uses (see duckdb.js).
export interface ArrowField {
  name: string;
  type: unknown;
}

export interface ArrowVector {
  get(index: number): unknown;
}

export interface ArrowTable {
  numRows: number;
  schema: { fields: ArrowField[] };
  getChild(name: string): ArrowVector | null;
}

export interface DuckConnection {
  query(sql: string): Promise<ArrowTable>;
}

export interface DuckDatabase {
  registerFileText(name: string, text: string): Promise<void>;
  dropFile(name: string): Promise<void>;
}

export function startDuckDB(): Promise<{ db: DuckDatabase; conn: DuckConnection }>;
