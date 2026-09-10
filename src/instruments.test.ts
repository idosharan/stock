import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORLD_INDICES } from "../src/config.js";
import * as instruments from "../src/instruments.js";
import { loadInstrumentConfig, saveInstrumentConfig, updateInstrumentConfig, validateInstrumentConfig, type InstrumentConfig } from "../src/instruments.js";

function fixture(): InstrumentConfig {
  return { version: 1, watchlist: [{ symbol: "DSCT.TA", name: "Discount" }],
    portfolio: [{ symbol: "DSCT.TA", name: "Discount", entryPrice: 3314.74, sector: "Banks" }],
    stockSectors: { "DSCT.TA": "Banks" } };
}

test("S&P 500 Energy is an analyzed world index and a supported reference index", () => {
  assert.ok(WORLD_INDICES.some(index => index.symbol === "^GSPE" && index.name.includes("Energy")));
  assert.ok(instruments.SUPPORTED_TRIGGER_INDICES.includes("^GSPE"));
  const config = fixture();
  config.portfolio.push({ name: "קסם אנרגיה", entryPrice: 4502, taseNumber: "1145903",
    investingUrl: "https://www.investing.com/etfs/ksm-4d-sp-energy", triggerIndex: "^GSPE" });
  assert.deepEqual(validateInstrumentConfig(config), config);
});

test("configuration rejects malformed, duplicate and unsafe records", () => {
  const valid = fixture();
  assert.deepEqual(validateInstrumentConfig(valid), valid);
  for (const entryPrice of [-1, 0, Infinity, "4502"]) {
    assert.throws(() => validateInstrumentConfig({ ...valid, portfolio: [{ ...valid.portfolio[0], entryPrice }] }), /entryPrice/);
  }
  assert.throws(() => validateInstrumentConfig({ ...valid, portfolio: [valid.portfolio[0], valid.portfolio[0]] }), /Duplicate/);
  assert.throws(() => validateInstrumentConfig({ ...valid, watchlist: [{ symbol: "$(curl evil)", name: "Bad" }] }), /symbol/);
  assert.throws(() => validateInstrumentConfig({ ...valid, portfolio: [{ name: "No source", entryPrice: 12 }] }), /source|identifier/);
  for (const investingUrl of ["http://www.investing.com/etfs/fund", "https://evil.test/etfs/fund", "https://www.investing.com@evil.test/etfs/fund", "https://www.investing.com:8443/etfs/fund"]) {
    assert.throws(() => validateInstrumentConfig({ ...valid, portfolio: [{ name: "Fund", taseNumber: "1145903", entryPrice: 4502, investingUrl }] }), /investingUrl/);
  }
  assert.throws(() => validateInstrumentConfig({ ...valid, typo: true }), /Unknown/);
});

test("managed holdings and watchlist accept only supported US or TASE identifier syntax", () => {
  for (const symbol of ["HPQ", "BRK-B", "DSCT.TA", "207.TA"]) {
    const config = { ...fixture(), watchlist: [{ symbol, name: "Stock" }],
      portfolio: [{ symbol, name: "Stock", entryPrice: 100 }], stockSectors: {} };
    assert.deepEqual(validateInstrumentConfig(config), config);
  }
  for (const symbol of ["VOD.L", "SHOP.TO", "0700.HK", "BRK.B", "^GSPC", "USDILS=X", "123", "A".repeat(16)]) {
    for (const target of ["portfolio", "watchlist"] as const) {
      const record = target === "portfolio" ? { symbol, name: "Stock", entryPrice: 100 } : { symbol, name: "Stock" };
      assert.throws(() => validateInstrumentConfig({ ...fixture(), [target]: [record] }), /symbol.*US.*TASE/i, `${target}: ${symbol}`);
    }
  }
});

test("trigger indices reject an identifier that the runner does not fetch", () => {
  for (const triggerIndex of ["TA125.TA", "HPQ", "VOD.L", "^UNKNOWN"]) {
    assert.throws(() => validateInstrumentConfig({ ...fixture(),
      portfolio: [{ ...fixture().portfolio[0], triggerIndex }] }), /triggerIndex.*supported/i);
  }
});

test("supported trigger indices stay aligned with every configured world index", () => {
  assert.deepEqual(new Set(instruments.SUPPORTED_TRIGGER_INDICES), new Set(WORLD_INDICES.map(index => index.symbol)));
  for (const { symbol: triggerIndex } of WORLD_INDICES) {
    const config = { ...fixture(), portfolio: [{ ...fixture().portfolio[0], triggerIndex }] };
    assert.deepEqual(validateInstrumentConfig(config), config);
  }
});

test("configuration and updates reject unknown record fields", () => {
  for (const target of ["portfolio", "watchlist"] as const) {
    const config = fixture();
    assert.throws(() => validateInstrumentConfig({ ...config, [target]: [{ ...config[target][0], typo: true }] }), /Unknown field: typo/);
    assert.throws(() => updateInstrumentConfig(config, { action: "update", target, id: "DSCT.TA",
      record: { typo: true } } as unknown as Parameters<typeof updateInstrumentConfig>[1]), /Unknown field: typo/);
    assert.throws(() => updateInstrumentConfig(config, { action: "remove", target, id: "DSCT.TA",
      record: { typo: true } } as unknown as Parameters<typeof updateInstrumentConfig>[1]), /Unknown field: typo/);
  }
  assert.throws(() => updateInstrumentConfig(fixture(), { action: "remove", target: "portfolio", id: "DSCT.TA", typo: true } as unknown as
    Parameters<typeof updateInstrumentConfig>[1]), /Unknown field: typo/);
});

test("duplicate watchlist names are rejected including through CRUD", () => {
  const config = fixture();
  assert.throws(() => validateInstrumentConfig({ ...config,
    watchlist: [...config.watchlist, { symbol: "HPQ", name: "Discount" }] }), /Duplicate.*name/);
  assert.throws(() => updateInstrumentConfig(config, { action: "add", target: "watchlist", id: "HPQ",
    record: { name: "Discount" } }), /Duplicate.*name/);
});

test("watchlist renames synchronize held names without changing entry prices", () => {
  const original = fixture();
  const updated = updateInstrumentConfig(original, { action: "update", target: "watchlist", id: "DSCT.TA",
    record: { name: "Renamed bank" } });
  assert.equal(updated.portfolio[0].name, "Renamed bank");
  assert.equal(updated.watchlist[0].name, "Renamed bank");
  assert.equal(updated.portfolio[0].entryPrice, 3314.74);
  assert.deepEqual(original, fixture());
  const renamedBack = updateInstrumentConfig(updated, { action: "update", target: "portfolio", id: "DSCT.TA",
    record: { name: "Discount" } });
  assert.deepEqual(renamedBack, original);
});

test("CRUD is immutable, preserves exact units and enforces explicit targets", () => {
  const original = fixture();
  const added = updateInstrumentConfig(original, { action: "add", target: "portfolio", id: "1145903",
    record: { name: "Energy", entryPrice: 4502, investingUrl: "https://www.investing.com/etfs/ksm-4d-sp-energy", sector: "Energy" } });
  assert.equal(original.portfolio.length, 1);
  assert.equal(added.portfolio[1].entryPrice, 4502);
  assert.equal(added.portfolio[1].taseNumber, "1145903");
  const changed = updateInstrumentConfig(added, { action: "update", target: "portfolio", id: "1145903", record: { entryPrice: 4503 } });
  assert.equal(changed.portfolio[1].name, "Energy");
  assert.equal(changed.portfolio[1].entryPrice, 4503);
  assert.throws(() => updateInstrumentConfig(added, { action: "add", target: "portfolio", id: "1145903", record: added.portfolio[1] }), /exists/);
  assert.throws(() => updateInstrumentConfig(added, { action: "update", target: "portfolio", id: "UNKNOWN", record: { name: "unknown" } }), /not found/);
  assert.throws(() => updateInstrumentConfig(added, { action: "remove", target: "watchlist", id: "DSCT.TA" }), /held/);
  const removed = updateInstrumentConfig(changed, { action: "remove", target: "portfolio", id: "1145903" });
  assert.deepEqual(removed, original);
  assert.throws(() => updateInstrumentConfig(original, { action: "execute" as "add", target: "portfolio", id: "HPQ" }), /action/);
});

test("held Yahoo instruments join analysis automatically and sector follows edits", () => {
  const updated = updateInstrumentConfig(fixture(), { action: "add", target: "portfolio", id: "HPQ",
    record: { name: "HP", entryPrice: 25, sector: "Technology", note: "$" } });
  assert.ok(updated.watchlist.some(stock => stock.symbol === "HPQ"));
  assert.equal(updated.stockSectors.HPQ, "Technology");
  const removed = updateInstrumentConfig(updated, { action: "remove", target: "portfolio", id: "HPQ" });
  assert.ok(removed.watchlist.some(stock => stock.symbol === "HPQ"));
});

test("validated settings persist and invalid save preserves original file", async () => {
  const root = await mkdtemp(join(tmpdir(), "tase-instruments-"));
  const file = join(root, "instruments.json");
  try {
    await saveInstrumentConfig(file, fixture());
    assert.deepEqual(loadInstrumentConfig(file), fixture());
    const original = await readFile(file, "utf8");
    await assert.rejects(saveInstrumentConfig(file, { ...fixture(), version: 2 } as unknown as InstrumentConfig));
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("default loading respects a trusted config path while explicit paths take precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "tase-instrument-path-"));
  const alternateFile = join(root, "alternate.json");
  const explicitFile = join(root, "explicit.json");
  const previous = process.env.INSTRUMENT_CONFIG_PATH;
  const alternate = updateInstrumentConfig(fixture(), { action: "update", target: "portfolio", id: "DSCT.TA", record: { entryPrice: 12 } });
  try {
    await saveInstrumentConfig(alternateFile, alternate);
    await saveInstrumentConfig(explicitFile, fixture());
    process.env.INSTRUMENT_CONFIG_PATH = alternateFile;
    assert.deepEqual(loadInstrumentConfig(), alternate);
    assert.deepEqual(loadInstrumentConfig(explicitFile), fixture());
    process.env.INSTRUMENT_CONFIG_PATH = join(root, "missing.json");
    assert.throws(() => loadInstrumentConfig(), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.INSTRUMENT_CONFIG_PATH;
    else process.env.INSTRUMENT_CONFIG_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("report and summary suites survive valid entry changes and holding removals", async () => {
  const root = await mkdtemp(join(tmpdir(), "tase-portfolio-regression-"));
  const file = join(root, "instruments.json");
  const original: InstrumentConfig = { ...fixture(), portfolio: [fixture().portfolio[0],
    { name: "Energy", taseNumber: "1145903", entryPrice: 4502, investingUrl: "https://www.investing.com/etfs/ksm-4d-sp-energy" },
    { name: "Defense", taseNumber: "1233170", entryPrice: 4749.19, investingUrl: "https://www.investing.com/etfs/hrlf238", triggerIndex: "207.TA" },
  ] };
  let changed = updateInstrumentConfig(original, { action: "update", target: "portfolio", id: "DSCT.TA", record: { entryPrice: 7777 } });
  changed = updateInstrumentConfig(changed, { action: "update", target: "portfolio", id: "1145903", record: { entryPrice: 9000 } });
  let removed = original;
  for (const id of ["DSCT.TA", "1145903", "1233170"]) removed = updateInstrumentConfig(removed, { action: "remove", target: "portfolio", id });
  const replaced = updateInstrumentConfig(removed, { action: "add", target: "portfolio", id: "BRK-B",
    record: { name: "Berkshire", entryPrice: 123.45 } });
  const cwd = new URL("../", import.meta.url);
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  const script = `const config = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ watchlist: config.WATCHLIST, portfolio: config.PORTFOLIO }));`;
  try {
    for (const config of [changed, removed, replaced]) {
      await saveInstrumentConfig(file, config);
      const env: NodeJS.ProcessEnv = { ...process.env, INSTRUMENT_CONFIG_PATH: file };
      delete env.NODE_TEST_CONTEXT;
      const options = { cwd, env, encoding: "utf8" as const, maxBuffer: 4 * 1024 * 1024 };
      const loaded = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], options);
      assert.deepEqual(JSON.parse(loaded), { watchlist: config.watchlist, portfolio: config.portfolio });
      const output = execFileSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap",
        fileURLToPath(new URL("report.test.ts", import.meta.url)), fileURLToPath(new URL("summary.test.ts", import.meta.url))], options);
      assert.match(output, /ok \d+ - historical evidence uses percent units/);
      assert.match(output, /ok \d+ - runner captures actual daily bar dates/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});