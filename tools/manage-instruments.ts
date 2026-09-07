import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadInstrumentConfig, saveInstrumentConfig, updateInstrumentConfig,
  validateInstrumentConfig, type InstrumentChange, type InstrumentConfig, type InstrumentHolding,
} from "../src/instruments.js";

export type FormEnvironment = Record<string, string | undefined>;

const inputNames = new Set([
  "INPUT_ACTION", "INPUT_MODE", "INPUT_TARGET", "INPUT_IDENTIFIER", "INPUT_NAME",
  "INPUT_ENTRY_PRICE", "INPUT_SECTOR", "INPUT_INVESTING_URL", "INPUT_ALERT_BELOW", "INPUT_TRIGGER_INDEX",
]);

export function plainTextBlock(text: string): string {
  const escaped = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return `<pre>${escaped}</pre>\n`;
}

function decimal(value: string): number {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error("Use a positive decimal price");
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Use a positive finite price");
  return price;
}

export function changeFromEnvironment(env: FormEnvironment): InstrumentChange {
  for (const key of Object.keys(env)) {
    if (key.startsWith("INPUT_") && !inputNames.has(key)) throw new Error("Unknown form input");
  }
  const action = env.INPUT_ACTION?.trim();
  const target = env.INPUT_TARGET?.trim();
  if (action !== "add" && action !== "update" && action !== "remove") throw new Error("Invalid management action");
  if (target !== "portfolio" && target !== "watchlist") throw new Error("Invalid management target");
  const id = env.INPUT_IDENTIFIER?.trim().toUpperCase() ?? "";
  if (/^\d+$/.test(id)) {
    if (!/^\d{5,10}$/.test(id) || target !== "portfolio") throw new Error("TASE numbers require a quote-only portfolio holding");
  } else if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,29}$/.test(id)) throw new Error("Invalid Yahoo identifier");

  const record: Partial<InstrumentHolding> = {};
  const fields = [
    ["INPUT_NAME", "name"], ["INPUT_ENTRY_PRICE", "entryPrice"],
    ["INPUT_SECTOR", "sector"], ["INPUT_INVESTING_URL", "investingUrl"],
    ["INPUT_ALERT_BELOW", "alertBelow"], ["INPUT_TRIGGER_INDEX", "triggerIndex"],
  ] as const;
  for (const [input, field] of fields) {
    const value = env[input]?.trim();
    if (!value) continue;
    if (action === "remove") throw new Error("Remove accepts only a target and identifier");
    if (target === "watchlist" && field !== "name" && field !== "sector") throw new Error("Holding fields are not supported on watchlist entries");
    if (value === "-") {
      if (action !== "update" || field === "name" || field === "entryPrice") throw new Error("Only optional update fields can be cleared");
      record[field] = undefined;
    } else if (field === "entryPrice" || field === "alertBelow") {
      record[field] = decimal(value);
    } else {
      record[field] = field === "triggerIndex" ? value.toUpperCase() : value;
    }
  }
  return { action, target, id, ...(action === "remove" ? {} : { record }) };
}

export function applyManagementChange(config: InstrumentConfig, change: InstrumentChange): InstrumentConfig {
  if (/^\d+$/.test(change.id) && config.portfolio.some(holding => holding.taseNumber === change.id && holding.symbol)) {
    throw new Error("Manage Yahoo holdings using their Yahoo symbol");
  }
  const updated = updateInstrumentConfig(config, change);
  if (change.record && Object.hasOwn(change.record, "sector") && change.record.sector === undefined) {
    const sectorSymbol = change.target === "watchlist" ? change.id
      : updated.portfolio.find(holding => holding.symbol === change.id || holding.taseNumber === change.id)?.symbol;
    if (sectorSymbol) delete updated.stockSectors[sectorSymbol];
  }
  return validateInstrumentConfig(updated);
}

export async function manageInstruments(env: FormEnvironment, args: string[] = []): Promise<string> {
  if (args.length && (args.length !== 1 || args[0] !== "--list")) throw new Error("Only --list is supported; mutations use environment variables");
  const file = env.INSTRUMENT_CONFIG_PATH || resolve("data", "instruments.json");
  const config = loadInstrumentConfig(file);
  if (args[0] === "--list" || env.INPUT_ACTION === "list") {
    const listing = JSON.stringify(config, null, 2);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, plainTextBlock(listing));
    return listing;
  }
  const change = changeFromEnvironment(env);
  await saveInstrumentConfig(file, applyManagementChange(config, change));
  return `Configuration saved (${change.action} ${change.target}).`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  manageInstruments(process.env, process.argv.slice(2)).then(output => console.log(output)).catch(() => {
    console.error("Instrument request rejected. Check action, target, identifier and field values; configuration was not changed unless saving already completed.");
    process.exitCode = 1;
  });
}