// A Durable Object's SQLite (ctx.storage.sql), shaped like the part of node:sqlite's
// DatabaseSync that src/store.js uses: exec, prepare → run / get / all, plus
// transaction(fn), since Durable Objects run transactions through transactionSync
// rather than BEGIN/COMMIT. BLOBs come back as ArrayBuffers here; they're turned into
// Buffers, as node:sqlite returns them.
import { Buffer } from 'node:buffer';

const fixRow = (row) => {
  for (const k in row) if (row[k] instanceof ArrayBuffer) row[k] = Buffer.from(row[k]);
  return row;
};
const fixArgs = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));

export class DurableSqlite {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
  }

  exec(sql) { this.sql.exec(sql); }

  prepare(sql) {
    const { sql: db } = this;
    return {
      all: (...args) => db.exec(sql, ...fixArgs(args)).toArray().map(fixRow),
      get: (...args) => {
        const row = db.exec(sql, ...fixArgs(args)).toArray()[0];
        return row ? fixRow(row) : undefined;
      },
      run: (...args) => {
        const cursor = db.exec(sql, ...fixArgs(args));
        cursor.toArray(); // run it to the end
        // rowsWritten also counts index writes: callers only test it for zero.
        return { changes: cursor.rowsWritten, lastInsertRowid: db.exec('SELECT last_insert_rowid() AS id').one().id };
      },
    };
  }

  transaction(fn) { return this.storage.transactionSync(fn); }
}
