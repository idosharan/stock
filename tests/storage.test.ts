import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DocumentStore, migrateLegacyStorage, pruneReportHtml, readCachedCandles, readHistory } from "../src/storage.js";
import { generateReport } from "../src/report.js";
import * as reportModule from "../src/report.js";
import { fetchCandles } from "../src/data.js";

function fixture(context: { after: (callback: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "tase-storage-"));
  mkdirSync(join(root, ".cache", "candles"), { recursive: true });
  mkdirSync(join(root, "reports"));
  context.after(() => {
    for (const dir of [join(root, ".cache", "candles"), join(root, ".cache"), join(root, "reports"), root]) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) unlinkSync(join(dir, entry.name));
      }
      rmdirSync(dir);
    }
  });
  return root;
}

const candle = { symbol: "^TEST", days: 730, fetchedAt: 1_000_000, candles: [["2026-09-04T00:00:00.000Z", 10, 12, 9, 11, 100]] };

test("documents survive reopening and failed transactions roll back", (context) => {
  const root = fixture(context);
  const file = join(root, "reports", "state.sqlite");
  const store = new DocumentStore(file);
  store.set("value", { count: 1 });
  assert.throws(() => store.transaction(() => {
    store.set("value", { count: 2 });
    store.set("other", true);
    throw new Error("abort");
  }), /abort/);
  store.close();
  const reopened = new DocumentStore(file);
  try {
    assert.deepEqual(reopened.get("value"), { count: 1 });
    assert.equal(reopened.get("other"), undefined);
  } finally { reopened.close(); }
});

test("migration verifies valid documents, preserves malformed originals, and is idempotent", (context) => {
  const root = fixture(context);
  const good = join(root, ".cache", "candles", "_TEST.json");
  const bad = join(root, ".cache", "candles", "bad.json");
  const history = join(root, "reports", "score-history.json");
  writeFileSync(good, JSON.stringify(candle));
  writeFileSync(bad, "{broken");
  writeFileSync(history, JSON.stringify({ daily: { "2026-09-04": { TEST: 7 } } }));
  const result = migrateLegacyStorage(root);
  assert.equal(result.candles, 1);
  assert.equal(result.histories, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(existsSync(good), false);
  assert.equal(existsSync(history), false);
  assert.equal(readFileSync(bad, "utf8"), "{broken");
  const store = new DocumentStore(join(root, "reports", "state.sqlite"));
  try { assert.deepEqual(readHistory(store, "score-history"), { daily: { "2026-09-04": { TEST: 7 } } }); }
  finally { store.close(); }
  assert.equal(migrateLegacyStorage(root).candles, 0);
});

test("conflicting migrations and invalid history shapes never overwrite durable state", (context) => {
  const root = fixture(context);
  const store = new DocumentStore(join(root, "reports", "state.sqlite"));
  const original = { daily: { "2026-09-04": { TEST: 7 } } };
  store.set("score-history", original);
  writeFileSync(join(root, "reports", "score-history.json"), JSON.stringify({ daily: { "2026-09-04": { TEST: 8 } } }));
  writeFileSync(join(root, "reports", "pick-history.json"), "[]");
  const result = migrateLegacyStorage(root);
  try {
    assert.equal(result.errors.length, 2);
    assert.equal(result.histories, 0);
    assert.deepEqual(store.get("score-history"), original);
    assert.equal(existsSync(join(root, "reports", "score-history.json")), true);
    store.set("signal-history", { daily: { "2026-09-04": { TEST: 42 } } });
    assert.throws(() => readHistory(store, "signal-history"), /Invalid/);
  } finally { store.close(); }
});

test("cache preserves symbol identity, TTL boundary, and requested days coverage", (context) => {
  const root = fixture(context);
  const store = new DocumentStore(join(root, ".cache", "candles.sqlite"));
  try {
    store.set("candle:^TEST", candle);
    assert.deepEqual(readCachedCandles(store, "^TEST", 730, 45, candle.fetchedAt + 45 * 60_000), candle);
    assert.equal(readCachedCandles(store, "^TEST", 730, 45, candle.fetchedAt + 45 * 60_000 + 1), null);
    assert.equal(readCachedCandles(store, "^TEST", 731, 45, candle.fetchedAt), null);
    assert.equal(readCachedCandles(store, "_TEST", 730, 45, candle.fetchedAt), null);
  } finally { store.close(); }
});

test("archives older dated HTML byte-for-byte and keeps 30 newest overall", (context) => {
  const root = fixture(context);
  const dir = join(root, "reports");
  const store = new DocumentStore(join(dir, "state.sqlite"));
  for (let day = 1; day <= 31; day++) {
    const name = `${day % 2 ? "report-daily" : "backtest"}-2026-08-${String(day).padStart(2, "0")}.html`;
    writeFileSync(join(dir, name), Buffer.from([60, 104, 116, 109, 108, 62, 255, day]));
  }
  writeFileSync(join(dir, "notes.html"), "untouched");
  try {
    assert.equal(pruneReportHtml(dir, store, 30), 1);
    assert.equal(existsSync(join(dir, "report-daily-2026-08-01.html")), false);
    assert.deepEqual(Buffer.from(store.get<string>("html:report-daily-2026-08-01.html")!, "base64"), Buffer.from([60, 104, 116, 109, 108, 62, 255, 1]));
    assert.equal(readdirSync(dir).filter((name) => /^(report|backtest)-.*\.html$/.test(name)).length, 30);
    assert.equal(readFileSync(join(dir, "notes.html"), "utf8"), "untouched");
    assert.equal(pruneReportHtml(dir, store, 30), 0);
  } finally { store.close(); }
});

test("archive verification failure keeps the HTML original", (context) => {
  const root = fixture(context);
  const dir = join(root, "reports");
  const store = new DocumentStore(join(dir, "state.sqlite"));
  const name = "report-daily-2026-08-01.html";
  writeFileSync(join(dir, name), "original");
  store.get = () => undefined;
  try {
    assert.throws(() => pruneReportHtml(dir, store, 0), /verification/i);
    assert.equal(readFileSync(join(dir, name), "utf8"), "original");
  } finally { store.close(); }
});

test("concurrent processes update documents without losing writes", async (context) => {
  const root = fixture(context);
  const file = join(root, "reports", "state.sqlite");
  const initial = new DocumentStore(file);
  initial.set("counter", 0);
  initial.close();
  const moduleUrl = new URL("../src/storage.ts", import.meta.url).href;
  const code = `import { DocumentStore } from ${JSON.stringify(moduleUrl)}; const store = new DocumentStore(${JSON.stringify(file)}); for (let index = 0; index < 20; index++) store.update('counter', value => (value ?? 0) + 1); store.close();`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const store = new DocumentStore(file);
  try { assert.equal(store.get("counter"), 80); }
  finally { store.close(); }
});

test("report generation migrates history, persists state, and prunes before rebuilding index", async (context) => {
  const root = fixture(context);
  const dir = join(root, "reports");
  const previousCwd = process.cwd();
  for (let day = 1; day <= 31; day++) {
    writeFileSync(join(dir, `report-daily-2026-08-${String(day).padStart(2, "0")}.html`), `<html>day ${day}</html>`);
  }
  writeFileSync(join(dir, "score-history.json"), JSON.stringify({ weekly: { "2026-08-01": { TEST: 9 } } }));
  process.chdir(root);
  try {
    await generateReport({ mode: "daily", results: [], indices: [], newsByStock: new Map(), allNews: [], generatedAt: new Date("2026-09-06T12:00:00Z") });
    assert.equal(existsSync(join(dir, "score-history.json")), false);
    assert.equal(readdirSync(dir).filter((file) => file.endsWith(".html")).length, 30);
    const index = readFileSync(join(root, "index.html"), "utf8");
    assert.doesNotMatch(index, /report-daily-2026-08-0[12]\.html/);
    assert.match(index, /report-daily-2026-09-06\.html/);
    const store = new DocumentStore(join(dir, "state.sqlite"));
    try {
      assert.deepEqual(store.get("score-history"), { weekly: { "2026-08-01": { TEST: 9 } }, daily: { "2026-09-06": {} } });
      assert.ok(store.get("html:report-daily-2026-08-01.html"));
    } finally { store.close(); }
  } finally { process.chdir(previousCwd); }
});

test("report generation refuses corrupt legacy history without replacing existing HTML", async (context) => {
  const root = fixture(context);
  const dir = join(root, "reports");
  const previousCwd = process.cwd();
  writeFileSync(join(dir, "score-history.json"), "{broken");
  writeFileSync(join(dir, "report-daily-2026-09-06.html"), "user report");
  process.chdir(root);
  try {
    await assert.rejects(generateReport({ mode: "daily", results: [], indices: [], newsByStock: new Map(), allNews: [], generatedAt: new Date("2026-09-06T12:00:00Z") }), /history|migration/i);
    assert.equal(readFileSync(join(dir, "score-history.json"), "utf8"), "{broken");
    assert.equal(readFileSync(join(dir, "report-daily-2026-09-06.html"), "utf8"), "user report");
  } finally { process.chdir(previousCwd); }
});

test("fetchCandles migrates and reads the SQLite cache without a network request", async (context) => {
  const root = fixture(context);
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const legacyFile = join(root, ".cache", "candles", "_TEST.json");
  writeFileSync(legacyFile, JSON.stringify({ ...candle, fetchedAt: Date.now() }));
  process.chdir(root);
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  try {
    assert.deepEqual(await fetchCandles("^TEST", 730), [{ date: new Date(candle.candles[0][0]), open: 10, high: 12, low: 9, close: 11, volume: 100 }]);
    assert.equal(existsSync(legacyFile), false);
    assert.equal(existsSync(join(root, ".cache", "candles.sqlite")), true);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(previousCwd);
  }
});

test("explicit maintenance preserves current output and repairs links only when pruning", async (context) => {
  const root = fixture(context);
  const dir = join(root, "reports");
  writeFileSync(join(root, "index.html"), "user index");
  writeFileSync(join(dir, "report-daily-2026-09-06.html"), "user report");
  assert.equal(typeof reportModule.maintainReportStorage, "function");
  const first = await reportModule.maintainReportStorage(root);
  assert.equal(first.archived, 0);
  assert.equal(readFileSync(join(root, "index.html"), "utf8"), "user index");
  for (let day = 1; day <= 31; day++) {
    writeFileSync(join(dir, `report-daily-2026-08-${String(day).padStart(2, "0")}.html`), `day ${day}`);
  }
  const second = await reportModule.maintainReportStorage(root);
  assert.equal(second.archived, 2);
  assert.doesNotMatch(readFileSync(join(root, "index.html"), "utf8"), /report-daily-2026-08-0[12]\.html/);
  assert.equal(readFileSync(join(dir, "report-daily-2026-09-06.html"), "utf8"), "user report");
});

test("partial archive failure still repairs links and preserves conflicting HTML", async (context) => {
  const root = fixture(context);
  const dir = join(root, "reports");
  for (let day = 1; day <= 31; day++) {
    writeFileSync(join(dir, `report-daily-2026-08-${String(day).padStart(2, "0")}.html`), `day ${day}`);
  }
  writeFileSync(join(dir, "report-daily-2026-09-06.html"), "latest");
  writeFileSync(join(root, "index.html"), "reports/report-daily-2026-08-02.html");
  const store = new DocumentStore(join(dir, "state.sqlite"));
  store.set("html:report-daily-2026-08-01.html", Buffer.from("older version").toString("base64"));
  store.close();
  await assert.rejects(reportModule.maintainReportStorage(root), /conflict/);
  assert.equal(existsSync(join(dir, "report-daily-2026-08-02.html")), false);
  assert.equal(readFileSync(join(dir, "report-daily-2026-08-01.html"), "utf8"), "day 1");
  assert.doesNotMatch(readFileSync(join(root, "index.html"), "utf8"), /report-daily-2026-08-02\.html/);
});