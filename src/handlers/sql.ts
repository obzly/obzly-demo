// SQL mode: a real DuckDB (WebAssembly, self-hosted, loaded on the first SQL
// query) over a "logs" table built from the time range's generated logs,
// with the backend's columns (backend/internal/features/logs/querier/sql.go):
// timestamp, level, message, client_ip, trace_id, span_id, fields (JSON text).
// logs_sql dashboard panels and alert rules run their SQL here too (runSql).
import type { ExecuteSQLQueryRequest } from '../../entity/query';
import { type GenLog, walkLogs } from '../gen/logs';
import { type DuckConnection, type DuckDatabase, startDuckDB } from '../lib/duckdb';
import { goDuration } from '../lib/http';
import { DemoError, type Router } from '../router';
import { requireProject } from './bootstrap';

/** Same cap as the backend's maxSQLResultRows. */
const MAX_RESULT_ROWS = 10_000;
/** Newest logs loaded into the table; a browser holds fewer than a server. */
const MAX_TABLE_ROWS = 150_000;

type Db = DuckDatabase;
type Conn = DuckConnection;

let engine: Promise<{ db: Db; conn: Conn }> | undefined;
let loadedKey: string | undefined;

function loadEngine() {
  engine ??= startDuckDB().catch((error) => {
    engine = undefined;
    throw new DemoError(
      422,
      `SQL mode couldn't start DuckDB in this browser (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  return engine;
}

/**
 * One read-only statement, like segments.ValidateSingleStatementSelect. File
 * and URL readers are refused too (the table is rebuilt from a registered
 * file, so external access can't simply be switched off).
 */
export function validateSql(sql: string): string {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!stripped) throw new DemoError(400, 'invalid query: empty statement');
  const outsideStrings = stripped.replace(/'(?:[^']|'')*'/g, "''");
  if (outsideStrings.includes(';')) {
    throw new DemoError(400, 'invalid query: only one statement is allowed');
  }
  if (!/^(select|with|from)\b/i.test(stripped)) {
    throw new DemoError(400, 'invalid query: only SELECT statements are allowed');
  }
  const blocked =
    /\b(insert|update|delete|drop|create|alter|attach|detach|copy|export|import|install|load|pragma|set|call|checkpoint|vacuum)\b/i;
  const hit = blocked.exec(outsideStrings);
  if (hit) throw new DemoError(400, `invalid query: ${hit[1].toUpperCase()} is not allowed`);
  if (/\b(read_\w+|glob|parquet_scan|sniff_csv)\s*\(/i.test(outsideStrings)) {
    throw new DemoError(400, 'invalid query: reading files is not allowed');
  }
  return stripped;
}

/** The backend's MaxSQLQueryLength for SQL saved in a panel or an alert rule. */
export const MAX_SAVED_SQL_LENGTH = 10_000;

/**
 * logs_core.ValidateSavedSQL: the SQL a logs_sql panel or alert rule keeps,
 * trimmed; required, at most 10,000 characters and one SELECT like SQL mode's.
 */
export function validateSavedSql(sql: unknown): string {
  const trimmed = typeof sql === 'string' ? sql.trim() : '';
  if (!trimmed) throw new DemoError(400, 'a SQL query is required');
  if (trimmed.length > MAX_SAVED_SQL_LENGTH) {
    throw new DemoError(400, `the SQL query exceeds the ${MAX_SAVED_SQL_LENGTH} character limit`);
  }
  try {
    validateSql(trimmed);
  } catch (error) {
    if (!(error instanceof DemoError)) throw error;
    throw new DemoError(400, `invalid SQL query: ${error.message.replace(/^invalid query: /, '')}`);
  }
  return trimmed;
}

async function prepareTable(conn: Conn, db: Db, projectId: string, from: number, to: number) {
  // Re-running a query on the same range reuses the table (rounded to 10 s).
  const key = `${projectId}:${Math.floor(from / 10_000)}:${Math.floor(to / 10_000)}`;
  if (key === loadedKey) return;
  const lines: string[] = [];
  walkLogs(projectId, from, to, 'desc', (log: GenLog) => {
    lines.push(
      JSON.stringify({
        ts: log.ts,
        level: log.level,
        message: log.message,
        client_ip: log.clientIp ?? null,
        trace_id: log.traceId ?? null,
        span_id: log.spanId ?? null,
        fields: JSON.stringify(log.fields),
      }),
    );
    return lines.length < MAX_TABLE_ROWS;
  });
  await conn.query('DROP TABLE IF EXISTS logs');
  await db.registerFileText('demo_logs.ndjson', lines.join('\n'));
  await conn.query(`CREATE TEMP TABLE logs AS
    SELECT make_timestamp(ts * 1000)::TIMESTAMP_NS AS timestamp, level, message, client_ip,
      trace_id, span_id, fields
    FROM read_json('demo_logs.ndjson', format = 'newline_delimited', columns = {
      ts: 'BIGINT', level: 'VARCHAR', message: 'VARCHAR', client_ip: 'VARCHAR',
      trace_id: 'VARCHAR', span_id: 'VARCHAR', fields: 'VARCHAR'})`);
  await db.dropFile('demo_logs.ndjson');
  loadedKey = key;
}

export const toCell = (value: unknown, isTime: boolean): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    const n = Number(value);
    if (isTime) return new Date(Math.abs(n) > 1e14 ? n / 1e6 : n).toISOString();
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (isTime && typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'object') {
    const maybe = value as { toJSON?: () => unknown };
    return JSON.parse(
      JSON.stringify(maybe.toJSON ? maybe.toJSON() : value, (_, v) =>
        typeof v === 'bigint' ? Number(v) : v,
      ),
    );
  }
  return value;
};

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  /** More than MAX_RESULT_ROWS rows; only the first ones are in rows. */
  truncated: boolean;
}

// One engine, one "logs" table: queries take turns, so a dashboard's SQL
// panels (each with its own range) don't rebuild the table under each other.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs one validated statement over the project's logs in [from, to] (epoch
 * ms): SQL mode, logs_sql dashboard panels and logs_sql alert rules.
 */
export function runSql(projectId: string, sql: string, from: number, to: number) {
  const statement = validateSql(sql);
  const run = queue.then(async (): Promise<SqlResult> => {
    const { db, conn } = await loadEngine();
    await prepareTable(conn, db, projectId, from, to);
    let table;
    try {
      table = await conn.query(statement);
    } catch (error) {
      throw new DemoError(
        400,
        `query execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const fields = table.schema.fields;
    const timeColumns = fields.map((field) => /timestamp|date/i.test(String(field.type)));
    const count = Math.min(table.numRows, MAX_RESULT_ROWS);
    const columns = fields.map((field) => table.getChild(field.name));
    const rows: unknown[][] = [];
    for (let i = 0; i < count; i++) {
      rows.push(columns.map((column, c) => toCell(column?.get(i), timeColumns[c])));
    }
    return {
      columns: fields.map((field) => field.name),
      rows,
      truncated: table.numRows > MAX_RESULT_ROWS,
    };
  });
  queue = run.catch(() => undefined);
  return run;
}

export function registerSql(r: Router) {
  r.post('/logs/query/execute-sql/:pid', async (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as ExecuteSQLQueryRequest;
    const started = performance.now();
    const to = body.timeRange?.to ? Date.parse(body.timeRange.to) : Date.now();
    const from = body.timeRange?.from ? Date.parse(body.timeRange.from) : to - 3_600_000;
    const result = await runSql(req.params.pid, body.sql ?? '', from, to);
    return {
      ...result,
      rowCount: result.rows.length,
      executedInMs: goDuration(performance.now() - started),
    };
  });
}
