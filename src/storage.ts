import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

interface Statement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  run(...parameters: unknown[]): unknown;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (file: string) => Database;
};

export class DocumentStore {
  private readonly database: Database;
  private inTransaction = false;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    try {
      this.database.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
      this.database.exec("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value FROM documents WHERE key = ?").get(key);
    if (!row) return undefined;
    try { return JSON.parse(String(row.value)) as T; }
    catch (error) { throw new Error(`Invalid stored JSON for ${key}`, { cause: error }); }
  }

  set<T>(key: string, value: T): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`Cannot store undefined for ${key}`);
    this.database.prepare("INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, encoded);
  }

  transaction<T>(action: () => T): T {
    if (this.inTransaction) throw new Error("Nested storage transactions are not supported");
    this.database.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Storage transactions must be synchronous");
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally { this.inTransaction = false; }
  }

  update<T>(key: string, update: (current: T | undefined) => T): T {
    return this.transaction(() => {
      const value = update(this.get<T>(key));
      this.set(key, value);
      return value;
    });
  }

  close(): void { this.database.close(); }
}

export type PackedCandle = [string, number, number, number, number, number];

export interface CandleCacheDocument {
  symbol: string;
  days: number;
  fetchedAt: number;
  candles: PackedCandle[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateCandles(value: unknown): asserts value is CandleCacheDocument {
  if (!isRecord(value) || typeof value.symbol !== "string" || !value.symbol ||
      !isFiniteNumber(value.days) || value.days <= 0 ||
      !isFiniteNumber(value.fetchedAt) || value.fetchedAt < 0 || !Array.isArray(value.candles) ||
      !value.candles.every((row: unknown) => Array.isArray(row) && row.length === 6 &&
        typeof row[0] === "string" && Number.isFinite(Date.parse(row[0])) && row.slice(1).every(isFiniteNumber))) {
    throw new Error("Invalid candle cache document");
  }
}

export function readCachedCandles(
  store: DocumentStore, symbol: string, days: number, ttlMinutes: number, now = Date.now()
): CandleCacheDocument | null {
  const value = store.get<unknown>(`candle:${symbol}`);
  if (value === undefined) return null;
  validateCandles(value);
  if (value.symbol !== symbol) throw new Error(`Invalid candle cache symbol for ${symbol}`);
  if (now < value.fetchedAt || now - value.fetchedAt > ttlMinutes * 60_000 || value.days < days) return null;
  return value;
}

export type HistoryKey = "score-history" | "pick-history" | "signal-history";
const HISTORY_KEYS: HistoryKey[] = ["score-history", "pick-history", "signal-history"];

function validateHistory(key: HistoryKey, value: unknown): void {
  const valid = isRecord(value) && Object.entries(value).every(([mode, dates]) =>
    (mode === "daily" || mode === "weekly") && isRecord(dates) && Object.entries(dates).every(([date, entry]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(entry)) return false;
      if (key === "score-history") return Object.values(entry).every(isFiniteNumber);
      if (key === "signal-history") return Object.values(entry).every((signals) =>
        Array.isArray(signals) && signals.every((signal) => typeof signal === "string"));
      return typeof entry.symbol === "string" && typeof entry.name === "string" &&
        isFiniteNumber(entry.price) && isFiniteNumber(entry.combined) &&
        (entry.stop === null || isFiniteNumber(entry.stop)) &&
        (entry.target === null || isFiniteNumber(entry.target));
    }));
  if (!valid) throw new Error(`Invalid ${key} document; refusing to replace history`);
}

export function readHistory<T extends object>(store: DocumentStore, key: HistoryKey): T {
  const value = store.get<unknown>(key);
  if (value === undefined) return {} as T;
  validateHistory(key, value);
  return value as T;
}

export interface MigrationResult {
  candles: number;
  histories: number;
  errors: { file: string; message: string }[];
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readOptional(file: string): Buffer | undefined {
  try { return readFileSync(file); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}

function unlinkVerified(file: string, original: Buffer): void {
  const current = readOptional(file);
  if (current === undefined) return;
  if (!current.equals(original)) throw new Error(`Source changed during migration: ${file}`);
  try { unlinkSync(file); }
  catch (error) { if (!missing(error)) throw error; }
}

function preserveDocument(store: DocumentStore, key: string, value: unknown): void {
  store.transaction(() => {
    const existing = store.get<unknown>(key);
    if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
      throw new Error(`Migration conflict for ${key}; original retained`);
    }
    if (existing === undefined) store.set(key, value);
    if (!isDeepStrictEqual(store.get(key), value)) throw new Error(`Storage verification failed for ${key}`);
  });
  if (!isDeepStrictEqual(store.get(key), value)) throw new Error(`Committed storage verification failed for ${key}`);
}

export function migrateLegacyStorage(root = process.cwd()): MigrationResult {
  const result: MigrationResult = { candles: 0, histories: 0, errors: [] };
  const reportDir = join(root, "reports");
  const cacheDir = join(root, ".cache", "candles");
  const migrate = (store: DocumentStore, file: string, kind: "candles" | "histories", historyKey?: HistoryKey) => {
    try {
      const original = readOptional(file);
      if (original === undefined) return;
      const value: unknown = JSON.parse(original.toString("utf8"));
      let key: string;
      if (historyKey) {
        validateHistory(historyKey, value);
        key = historyKey;
      } else {
        validateCandles(value);
        key = `candle:${value.symbol}`;
      }
      preserveDocument(store, key, value);
      unlinkVerified(file, original);
      result[kind]++;
    } catch (error) { result.errors.push({ file, message: (error as Error).message }); }
  };
  const historyStore = new DocumentStore(join(reportDir, "state.sqlite"));
  try {
    for (const key of HISTORY_KEYS) migrate(historyStore, join(reportDir, `${key}.json`), "histories", key);
  } finally { historyStore.close(); }
  const candleStore = new DocumentStore(join(root, ".cache", "candles.sqlite"));
  try {
    let files: string[];
    try { files = readdirSync(cacheDir); }
    catch (error) { if (!missing(error)) throw error; files = []; }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      migrate(candleStore, join(cacheDir, file), "candles");
    }
  } finally { candleStore.close(); }
  return result;
}

export function pruneReportHtml(dir: string, store: DocumentStore, retain = 30): number {
  if (!Number.isInteger(retain) || retain < 0) throw new Error("Invalid HTML retention count");
  const dated = readdirSync(dir).flatMap((file) => {
    const match = /^(?:report-(?:daily|weekly)|backtest)-(\d{4}-\d{2}-\d{2})\.html$/.exec(file);
    return match ? [{ file, date: match[1] }] : [];
  }).sort((left, right) => right.date.localeCompare(left.date) || right.file.localeCompare(left.file));
  let archived = 0;
  for (const { file } of dated.slice(retain)) {
    const source = join(dir, file);
    const original = readOptional(source);
    if (original === undefined) continue;
    preserveDocument(store, `html:${file}`, original.toString("base64"));
    unlinkVerified(source, original);
    archived++;
  }
  return archived;
}