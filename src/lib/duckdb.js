// Loads DuckDB-WASM (self-hosted bundle files, emitted by Vite). Plain JS with
// duckdb.d.ts beside it: DuckDB's own typings pull in @types/node (via
// apache-arrow), which would change the app's global types (setTimeout).
export async function startDuckDB() {
  const [duckdb, { default: wasmUrl }, { default: workerUrl }] = await Promise.all([
    import('@duckdb/duckdb-wasm'),
    import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'),
  ]);
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(wasmUrl);
  const conn = await db.connect();
  return { db, conn };
}
