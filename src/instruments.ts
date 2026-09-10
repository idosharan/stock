import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface InstrumentStock { symbol: string; name: string }
export interface InstrumentHolding {
  symbol?: string;
  name: string;
  entryPrice: number;
  note?: string;
  triggerIndex?: string;
  alertBelow?: number;
  investingUrl?: string;
  taseNumber?: string;
  sector?: string;
}
export interface InstrumentConfig {
  version: 1;
  watchlist: InstrumentStock[];
  portfolio: InstrumentHolding[];
  stockSectors: Record<string, string>;
}
export interface InstrumentChange {
  action: "add" | "update" | "remove";
  target: "portfolio" | "watchlist";
  id: string;
  record?: Partial<InstrumentHolding>;
}

export const SUPPORTED_TRIGGER_INDICES: readonly string[] = Object.freeze([
  "^GSPC", "^DJI", "^IXIC", "^NDX", "^RUT", "^VIX", "^GSPE", "TA35.TA", "TA90.TA", "207.TA",
  "^GDAXI", "^FTSE", "^FCHI", "^STOXX50E", "^N225", "^HSI", "000001.SS", "^KS11",
]);

const symbolPattern = /^(?:[A-Z][A-Z0-9-]{0,14}|[A-Z0-9][A-Z0-9-]{0,26}\.TA)$/;
const numberPattern = /^\d{5,10}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value as Record<string, unknown>;
}

function knownKeys(record: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`);
}

function text(value: unknown, label: string, maximum = 120): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[<>\x00-\x1f]/.test(value)) {
    throw new Error(`${label}: invalid text`);
  }
}

function symbol(value: unknown): asserts value is string {
  text(value, "symbol", 30);
  if (!symbolPattern.test(value)) throw new Error("Invalid symbol: use simple US or .TA TASE identifier syntax");
}

function positive(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label}: expected positive finite number`);
}

export function validateInstrumentConfig(input: unknown): InstrumentConfig {
  const config = object(input, "configuration");
  knownKeys(config, ["version", "watchlist", "portfolio", "stockSectors"]);
  if (config.version !== 1) throw new Error("Unsupported configuration version");
  if (!Array.isArray(config.watchlist) || !Array.isArray(config.portfolio)) throw new Error("Expected instrument arrays");
  if (config.watchlist.length > 500 || config.portfolio.length > 200) throw new Error("Instrument limit exceeded");
  const watchSymbols = new Set<string>();
  const watchNames = new Set<string>();
  for (const item of config.watchlist) {
    const stock = object(item, "stock");
    knownKeys(stock, ["symbol", "name"]);
    symbol(stock.symbol);
    text(stock.name, "name");
    if (watchSymbols.has(stock.symbol)) throw new Error(`Duplicate symbol: ${stock.symbol}`);
    if (watchNames.has(stock.name)) throw new Error(`Duplicate watchlist name: ${stock.name}`);
    watchSymbols.add(stock.symbol);
    watchNames.add(stock.name);
  }
  const identifiers = new Set<string>();
  const names = new Set<string>();
  for (const item of config.portfolio) {
    const holding = object(item, "holding");
    knownKeys(holding, ["symbol", "name", "entryPrice", "note", "triggerIndex", "alertBelow", "investingUrl", "taseNumber", "sector"]);
    text(holding.name, "name");
    positive(holding.entryPrice, "entryPrice");
    if (names.has(holding.name)) throw new Error(`Duplicate holding name: ${holding.name}`);
    names.add(holding.name);
    if (holding.symbol !== undefined) symbol(holding.symbol);
    if (holding.taseNumber !== undefined && (typeof holding.taseNumber !== "string" || !numberPattern.test(holding.taseNumber))) throw new Error("Invalid TASE identifier");
    if (!holding.symbol && (!holding.taseNumber || !holding.investingUrl)) throw new Error("Quote-only holding requires TASE identifier and price source");
    for (const key of ["symbol", "taseNumber"]) {
      if (holding[key] === undefined) continue;
      const identifier = `${key}:${holding[key]}`;
      if (identifiers.has(identifier)) throw new Error(`Duplicate identifier: ${identifier}`);
      identifiers.add(identifier);
    }
    for (const key of ["note", "sector"]) if (holding[key] !== undefined) text(holding[key], key);
    if (holding.triggerIndex !== undefined && (typeof holding.triggerIndex !== "string" || !SUPPORTED_TRIGGER_INDICES.includes(holding.triggerIndex))) {
      throw new Error(`Invalid triggerIndex: known supported indices are ${SUPPORTED_TRIGGER_INDICES.join(", ")}`);
    }
    if (holding.alertBelow !== undefined) positive(holding.alertBelow, "alertBelow");
    if (holding.investingUrl !== undefined) {
      text(holding.investingUrl, "investingUrl", 250);
      let url: URL;
      try { url = new URL(holding.investingUrl); } catch { throw new Error("Invalid investingUrl"); }
      if (url.protocol !== "https:" || url.hostname !== "www.investing.com" || url.port || url.username || url.password || url.search || url.hash || !/^\/(etfs|equities)\/[a-z0-9-]+$/.test(url.pathname)) throw new Error("Invalid investingUrl: use an HTTPS Investing instrument page");
    }
  }
  for (const [key, value] of Object.entries(object(config.stockSectors, "stockSectors"))) {
    symbol(key);
    text(value, "sector");
  }
  return structuredClone(input) as InstrumentConfig;
}

export function loadInstrumentConfig(file = process.env.INSTRUMENT_CONFIG_PATH || join(process.cwd(), "data", "instruments.json")): InstrumentConfig {
  return validateInstrumentConfig(JSON.parse(readFileSync(file, "utf8")));
}

export function updateInstrumentConfig(input: InstrumentConfig, change: InstrumentChange): InstrumentConfig {
  const config = validateInstrumentConfig(input);
  knownKeys(object(change, "change"), ["action", "target", "id", "record"]);
  if (!["add", "update", "remove"].includes(change.action)) throw new Error("Invalid action");
  if (!["portfolio", "watchlist"].includes(change.target)) throw new Error("Invalid target");
  if (change.record !== undefined) knownKeys(object(change.record, "record"), change.target === "watchlist"
    ? ["symbol", "name", "sector"]
    : ["symbol", "name", "entryPrice", "note", "triggerIndex", "alertBelow", "investingUrl", "taseNumber", "sector"]);
  const isTase = numberPattern.test(change.id);
  if (!isTase) symbol(change.id);
  if (isTase && change.target === "watchlist") throw new Error("Watchlist requires a Yahoo symbol");
  const records: (InstrumentHolding | InstrumentStock)[] = config[change.target];
  const index = records.findIndex(record => record.symbol === change.id || ("taseNumber" in record && record.taseNumber === change.id));
  if (change.action === "add" && index >= 0) throw new Error("Instrument already exists");
  if (change.action !== "add" && index < 0) throw new Error("Instrument not found");
  if (change.action === "remove") {
    if (change.target === "watchlist" && config.portfolio.some(holding => holding.symbol === change.id)) throw new Error("Cannot remove a held instrument from watchlist");
    records.splice(index, 1);
    if (change.target === "watchlist") delete config.stockSectors[change.id];
  } else {
    const patch = { ...change.record };
    if (patch.symbol && patch.symbol !== change.id && !isTase) throw new Error("Cannot change identifier");
    if (patch.taseNumber && isTase && patch.taseNumber !== change.id) throw new Error("Cannot change identifier");
    const identifier = isTase ? { taseNumber: change.id } : { symbol: change.id };
    const record = { ...(index < 0 ? {} : records[index]), ...patch, ...identifier };
    if (change.target === "watchlist") {
      knownKeys(record, ["symbol", "name", "sector"]);
      if (record.sector) config.stockSectors[change.id] = record.sector;
      delete record.sector;
      const holding = config.portfolio.find(item => item.symbol === record.symbol);
      if (holding) holding.name = record.name!;
    }
    if (index < 0) records.push(record as InstrumentHolding);
    else records[index] = record as InstrumentHolding;
    if (change.target === "portfolio" && record.symbol) {
      const stock = config.watchlist.find(item => item.symbol === record.symbol);
      if (stock) stock.name = record.name!;
      else config.watchlist.push({ symbol: record.symbol, name: record.name! });
      if (record.sector) config.stockSectors[record.symbol] = record.sector;
    }
  }
  return validateInstrumentConfig(config);
}

export async function saveInstrumentConfig(file: string, input: InstrumentConfig): Promise<void> {
  const config = validateInstrumentConfig(input);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}