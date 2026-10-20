import { createRequire } from "node:module";

export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
  close(): void;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface BunSqliteDatabase {
  query(sql: string): SqliteStatement;
  run(sql: string, params?: unknown[]): unknown;
  close(): void;
}

interface NodeSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

function createPreparedConn(db: NodeSqliteDatabase): SqliteConn {
  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    },
    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.prepare(sql);
      return (stmt.get(...(params ?? [])) as T | undefined) ?? null;
    },
    run(sql: string, params?: unknown[]): void {
      const stmt = db.prepare(sql);
      stmt.run(...(params ?? []));
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    close(): void {
      db.close();
    },
  };
}

function createBunConn(db: BunSqliteDatabase): SqliteConn {
  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      return db.query(sql).all(...(params ?? [])) as T[];
    },
    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      return (db.query(sql).get(...(params ?? [])) as T | undefined) ?? null;
    },
    run(sql: string, params?: unknown[]): void {
      db.run(sql, params ?? []);
    },
    exec(sql: string): void {
      db.run(sql);
    },
    close(): void {
      db.close();
    },
  };
}

// Open a sqlite connection with the runtime's bundled engine: bun:sqlite when running
// inside OpenCode (Bun), node:sqlite when running under Node (tests, CI).
// Bun 1.3 removed the Bun.sqlite global and ships the engine as the bun:sqlite module, so
// the branch reads the runtime version and the module goes through the same createRequire
// seam either way: the module exists in old and new Bun alike, and a bare require is not
// defined in the ES module the plugin ships as.
// The loader is a parameter so tests can supply the module on a runtime that lacks it.
export function openSqlite(path: string, load: (id: string) => unknown = nodeRequire): SqliteConn {
  if (process.versions.bun !== undefined) {
    const { Database } = load("bun:sqlite") as BunSqliteExports;
    return createBunConn(new Database(path));
  }

  const { DatabaseSync } = load("node:sqlite") as NodeSqliteExports;
  return createPreparedConn(new DatabaseSync(path));
}

const nodeRequire = createRequire(import.meta.url);

interface NodeSqliteExports {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

interface BunSqliteExports {
  Database: new (path: string) => BunSqliteDatabase;
}
