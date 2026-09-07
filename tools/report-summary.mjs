#!/usr/bin/env node
// מדפיס סיכום טקסטואלי של דוח HTML שנוצר (תיק, המלצות, מדדים, תחזית) —
// מחליף פענוח אד-הוק ב-PowerShell כדי שתהליך הדוח ירוץ בפקודות מאושרות מראש בלבד.
// שימוש: npm run summary [-- --mode=daily|weekly] [--date=YYYY-MM-DD] [--file=path|-] [--top=5]

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    return m ? [m[1], m[2] || "true"] : [a, "true"];
  })
);

const mode = args.mode === "weekly" ? "weekly" : "daily";
const top = Number(args.top ?? 5);

function resolveReportFile() {
  if (args.file) return path.resolve(ROOT, args.file);
  const dir = path.join(ROOT, "reports");
  if (args.date) return path.join(dir, `report-${mode}-${args.date}.html`);
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`report-${mode}-`) && f.endsWith(".html"))
    .sort();
  if (!files.length) throw new Error(`לא נמצאו דוחות מסוג ${mode} בתיקייה reports/`);
  return path.join(dir, files[files.length - 1]);
}

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const toText = (html) =>
  decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " · ")
      .replace(/<\/(li|p|div|tr|h[1-6]|article|section|summary|details|ul|table)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

const inline = (html) => toText(html).split("\n").join(" · ");

function sectionByTitle(html, keyword) {
  const parts = html.split(/<h2[^>]*>/i).slice(1);
  for (const part of parts) {
    const end = part.indexOf("</h2>");
    const title = toText(part.slice(0, end));
    if (title.includes(keyword)) return { title, body: part.slice(end + 5) };
  }
  return null;
}

function printSection(html, keyword) {
  const sec = sectionByTitle(html, keyword);
  if (!sec) return;
  console.log(`\n===== ${sec.title} =====`);
  console.log(toText(sec.body));
}

const file = args.file === "-" ? null : resolveReportFile();
const html = readFileSync(file ?? 0, "utf8");

console.log(`# ${file ? path.relative(ROOT, file).replace(/\\/g, "/") : "stdin"}`);
const embedded = /<script\b(?=[^>]*\btype=["']application\/json["'])(?=[^>]*\bid=["']report-summary["'])[^>]*>([\s\S]*?)<\/script>/i.exec(html);
let snapshot;
try {
  const parsed = embedded ? JSON.parse(embedded[1]) : null;
  if (parsed?.version === 1 && typeof parsed.summary === "string" && typeof parsed.body === "string"
    && typeof parsed.ranking?.order === "string" && Array.isArray(parsed.ranking.rows)
    && parsed.ranking.rows.every((row) => typeof row === "string")) snapshot = parsed;
} catch {}
if (snapshot) {
  if (top === 5) console.log(snapshot.summary);
  else {
    console.log(snapshot.body);
    if (top > 0 && snapshot.ranking.rows.length) {
      console.log(`\n===== ${top} המובילות בטבלה — סדר ${snapshot.ranking.order} =====`);
      console.log(snapshot.ranking.rows.slice(0, top).join("\n"));
    }
  }
  process.exit(0);
}
const generated = /<p class="generated">([\s\S]*?)<\/p>/.exec(html);
if (generated) console.log(toText(generated[1]));

const stats = /<section class="stats">([\s\S]*?)<\/section>/.exec(html);
if (stats) console.log(`\n===== ספירת המלצות =====\n${inline(stats[1])}`);

printSection(html, "התיק שלי");
printSection(html, "המלצת הרכישה");
printSection(html, "המלצות מכירה");
printSection(html, "תחזית האייג");

// מדדים — שורה קומפקטית לכל מדד במקום כל כרטיס המדד
const idxCards = [...html.matchAll(/<article class="idx-card">([\s\S]*?)<\/article>/g)];
if (idxCards.length) {
  console.log("\n===== מדדים =====");
  for (const [, card] of idxCards) {
    const name = /<h4>([\s\S]*?)<\/h4>/.exec(card);
    const stance = /<span class="badge[^"]*">([\s\S]*?)<\/span>/.exec(card);
    const price = /<span class="idx-price">([\s\S]*?)<\/span>/.exec(card);
    const chg = /<span class="idx-chg[^"]*">([\s\S]*?)<\/span>/.exec(card);
    const score = /<span class="idx-score">([\s\S]*?)<\/span>/.exec(card);
    const fresh = [...card.matchAll(/<li>([\s\S]*?)<\/li>/g)]
      .map(([, s]) => toText(s))
      .filter((s) => s.startsWith("🔔"));
    console.log(
      [
        inline(name?.[1] ?? ""),
        toText(stance?.[1] ?? ""),
        toText(price?.[1] ?? ""),
        toText(chg?.[1] ?? ""),
        toText(score?.[1] ?? ""),
        ...fresh,
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

const details = new Map(
  [...html.matchAll(/<details class="detail">([\s\S]*?)<\/details>/g)].map(([, body]) => [
    toText(/<small>([\s\S]*?)<\/small>/.exec(body)?.[1] ?? ""),
    body,
  ])
);
const portfolioSection = sectionByTitle(html, "התיק שלי");
const portfolioHtml = portfolioSection?.body.split(/<\/section>/i)[0];
const portfolioNames = portfolioHtml == null ? null : [...portfolioHtml.matchAll(/<td\b[^>]*class=["']name["'][^>]*>([\s\S]*?)<\/td>/gi)]
  .map(([, cell]) => toText(cell.replace(/<small\b[^>]*>[\s\S]*?<\/small>/gi, "")));
const reportSymbols = portfolioHtml == null ? [] : [...portfolioHtml.matchAll(/<small\b[^>]*>([\s\S]*?)<\/small>/gi)]
  .map(([, text]) => toText(text)).filter((text) => /^(?:\^?[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*|\d+\.TA)$/.test(text));
for (const [symbol, body] of details) {
  const summary = /<summary\b[^>]*>([\s\S]*?)<small\b/i.exec(body)?.[1] ?? "";
  const name = toText(summary.replace(/<span\b[^>]*class="badge[^>]*>[\s\S]*?<\/span>/i, ""));
  if (portfolioNames?.includes(name)) reportSymbols.push(symbol);
}
let configuredHoldings = [];
try {
  const config = JSON.parse(readFileSync(path.join(ROOT, "data", "instruments.json"), "utf8"));
  if (Array.isArray(config.portfolio)) configuredHoldings = config.portfolio;
} catch {}
const heldSymbols = [...new Set([...reportSymbols, ...configuredHoldings
  .filter((holding) => typeof holding.symbol === "string" && (portfolioHtml == null || portfolioNames?.includes(holding.name)))
  .map((holding) => holding.symbol)])];
console.log("\n===== פירוט איתותים — החזקות התיק =====");
for (const sym of heldSymbols) {
  const body = details.get(sym);
  console.log(`\n--- ${sym} ---`);
  console.log(body ? toText(body) : "אין ניתוח בדוח (ייתכן שאין מספיק נתונים)");
}

// שורות מובילות מהטבלה המלאה
const rankingTable = /<table\b[^>]*\bid="ranking-table"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
  ?? /<h2[^>]*>\s*טבלת המלצות מלאה\s*<\/h2>\s*<div\b[^>]*>\s*<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
const tbody = rankingTable && /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(rankingTable);
if (tbody && top > 0) {
  const rows = [...tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(0, top);
  const heading = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(rankingTable)?.[1] ?? "";
  const order = toText(heading).includes("משולב") ? "ציון משולב" : "ציון טכני";
  console.log(`\n===== ${top} המובילות בטבלה — סדר ${order} =====`);
  for (const [, row] of rows) console.log(inline(row));
}
