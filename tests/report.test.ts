import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { buildIndexHtml, renderReportHtml, type ReportHtmlInput } from "../src/html.js";
import type { HistoricalForecast } from "../src/forecast.js";
import { Script } from "node:vm";

function reportInput(): ReportHtmlInput {
  return {
    mode: "daily", results: [], indices: [], newsByStock: new Map(),
    generatedAt: new Date("2026-09-06T12:00:00Z"),
    forecast: { horizon: "היום", summary: "סקירה", markets: [],
      newsTone: { positive: 0, negative: 0, neutral: 0, label: "ניטרלי" } },
  };
}

function evidence(symbol = "DSCT.TA"): HistoricalForecast {
  return {
    symbol, asOf: "2026-09-04", regime: "trend", warnings: ['<img src=x onerror="bad()">'],
    horizons: [{ days: 5, status: "estimated", sampleCount: 40, probabilityUp: 0.625,
      probabilityInterval: [0.47, 0.76], medianReturn: 1.25, p10: -2.5, p90: 4.75,
      baselineProbability: 0.51, baselineReturn: 0.5, excessReturn: 0.75,
      analogDates: ["2024-01-02", "<bad-date>"], reason: null },
    { days: 10, status: "insufficient", sampleCount: 3, probabilityUp: null,
      probabilityInterval: null, medianReturn: null, p10: null, p90: null,
      baselineProbability: null, baselineReturn: null, excessReturn: null,
      analogDates: [], reason: "מעט <נתונים>" }], events: [],
  };
}

test("summary reads ranking rows, not the earlier portfolio table", () => {
  const symbols = ['FIRST.TA', 'SECOND.TA', 'THIRD.TA', 'FOURTH.TA', 'FIFTH.TA'];
  const html = `<html><section><h2>התיק שלי</h2><table><tbody><tr><td>PORTFOLIO</td></tr></tbody></table></section>
    <section><h2>טבלת המלצות מלאה</h2><table id="ranking-table"><thead><tr><th>משולב</th></tr></thead><tbody>
    ${symbols.map(symbol => `<tr><td class="sym">${symbol}</td><td>75</td></tr>`).join('')}
    <tr><td>SIXTH.TA</td></tr></tbody></table></section></html>`;
  const output = execFileSync(process.execPath, [
    "tools/report-summary.mjs", "--file=-", "--top=5",
  ], { input: html, encoding: "utf8", cwd: new URL("../", import.meta.url), maxBuffer: 2 * 1024 * 1024 });
  const top = output.slice(output.lastIndexOf("===== 5"));
  for (const symbol of symbols) assert.ok(top.includes(symbol), `Missing ranked symbol ${symbol}`);
  assert.match(top, /משולב/);
  assert.equal(top.trim().split("\n").length, 6);
  assert.doesNotMatch(top, /SIXTH|PORTFOLIO/);
});

test("historical evidence uses percent units, intervals and explicit abstention", () => {
  const html = renderReportHtml({ ...reportInput(), historicalForecasts: new Map([["DSCT.TA", evidence()]]) });
  assert.match(html, /ראיות היסטוריות לתיק/);
  assert.match(html, /2026-09-04/);
  for (const value of ["62.5%", "47.0%", "76.0%", "1.25%", "-2.50%", "4.75%", "51.0%", "0.50%", "0.75%"])
    assert.ok(html.includes(value), `Missing ${value}`);
  assert.match(html, /95%/);
  assert.match(html, /שכיחות היסטורית/);
  assert.match(html, /ניסיוני/);
  assert.match(html, /אין מספיק נתונים/);
  assert.match(html, /אין מאגר אירועים מתוארך/);
  assert.match(html, /מעט &lt;נתונים&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /20 ימי מסחר/);
});

test("reports without historical data retain sections and accessible ranking controls", () => {
  const html = renderReportHtml(reportInput());
  assert.match(html, /אין נתוני תחזית היסטורית/);
  assert.match(html, /id="ranking-table"/);
  assert.match(html, /id="ranking-search"/);
  assert.match(html, /aria-sort="none"/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media print/);
  assert.match(html, /טבלת המלצות מלאה/);
  assert.match(html, /פירוט מלא לכל המניות/);
});

test("index protects embedded report data and resets an empty tab", () => {
  const html = buildIndexHtml([{ mode: "daily", date: "2026-09-06", file: '</script><img src=x onerror="bad()">' }]);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /frame\.removeAttribute\('src'\)/);
  assert.match(html, /date\.textContent = fmtDate/);
});

test("summary accepts a stdin fixture and labels combined ranking with sortable headings", () => {
  const fixture = `<html><section><h2>התיק שלי</h2><table><tbody><tr><td>PORTFOLIO</td></tr></tbody></table></section>
    <section><h2>טבלת המלצות מלאה</h2><table id="ranking-table"><thead><tr><th><button>משולב</button></th></tr></thead>
    <tbody><tr><td>RANKED.TA</td><td>95</td></tr></tbody></table></section></html>`;
  const output = execFileSync(process.execPath, ["tools/report-summary.mjs", "--file=-", "--top=1"], {
    cwd: new URL("../", import.meta.url), input: fixture, encoding: "utf8",
  });
  const top = output.slice(output.lastIndexOf("===== 1"));
  assert.ok(top.includes("RANKED.TA"));
  assert.ok(top.includes("ציון משולב"));
  assert.ok(!top.includes("PORTFOLIO"));
});

test("stock and index details receive evidence without mixing the heuristic forecast", () => {
  const input = reportInput();
  input.results = [{ symbol: "TEST.TA", name: "בדיקה", price: 100, score: 10,
    recommendation: "החזקה", signals: [], patterns: [], liquidityNote: "",
    sequenceStop: null, risk: null, size: null, levels: { support: null, resistance: null },
    relativeStrength: null, earningsInDays: null, fundamentals: null, newsSentiment: 0,
    indicators: { rsi: null, adx: null, stochK: null, trendUp: false },
  } as ReportHtmlInput["results"][number]];
  input.indices = [{ symbol: "^NDX", name: "נאסדק", region: "ארה\"ב", price: 100,
    changePct: null, score: 0, stance: "ניטרלי", recommendation: "מעקב", signals: [],
    indicators: { rsi: null, macdHist: null, adx: null, roc: null, atrPct: null, trendUp: false, aboveSmaLong: false },
  }];
  input.forecast.markets = [{ market: "נאסדק", icon: "", direction: "יציבות / דשדוש", horizon: "היום", score: 0,
    reasoning: ["בדיקה"], watchpoints: ["VIX נמוך: רוגע יחסי בשווקים, פחות סיכון לזעזועים"] }];
  input.historicalForecasts = new Map([["TEST.TA", evidence("TEST.TA")], ["^NDX", evidence("^NDX")]]);
  const html = renderReportHtml(input);
  const stock = html.slice(html.indexOf('<details class="detail">'));
  const index = html.slice(html.indexOf('<article class="idx-card">'), html.indexOf('</article>', html.indexOf('<article class="idx-card">')));
  assert.ok(stock.includes("62.5%"));
  assert.ok(index.includes("62.5%"));
  assert.ok(html.includes("הערכה היוריסטית"));
  assert.ok(!html.includes("פחות סיכון לזעזועים"));
  assert.ok(html.includes("אין בכך לשלול זעזועים"));
  for (const document of [html, buildIndexHtml([])]) {
    for (const script of document.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Script(script[1]));
    }
  }
});

test("generated ranking script sorts numeric values and filters names and symbols", () => {
  const html = renderReportHtml(reportInput());
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const rows = [
    { cells: ["1", "אלפא", "AAA.TA", "100", "9"].map(textContent => ({ textContent })), hidden: false },
    { cells: ["2", "בטא", "BBB.TA", "200", "80"].map(textContent => ({ textContent })), hidden: false },
    { cells: ["3", "גמא", "CCC.TA", "300", "-5"].map(textContent => ({ textContent })), hidden: false },
  ];
  let rendered = [...rows];
  let sort: () => void = () => {};
  let filter: () => void = () => {};
  const attributes = new Map([["aria-sort", "none"]]);
  const heading = {
    getAttribute: (name: string) => attributes.get(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const button = { dataset: { column: "4", numeric: "true" }, closest: () => heading,
    addEventListener: (_event: string, listener: () => void) => { sort = listener; } };
  const search = { value: "", addEventListener: (_event: string, listener: () => void) => { filter = listener; } };
  const count = { textContent: "" };
  const empty = { hidden: true };
  const table = {
    tBodies: [{ rows, appendChild: (row: typeof rows[number]) => { rendered = rendered.filter(item => item !== row); rendered.push(row); } }],
    querySelectorAll: (selector: string) => selector === ".sort-button" ? [button] : [heading],
  };
  const elements = new Map<string, unknown>([["ranking-table", table], ["ranking-search", search], ["ranking-count", count], ["ranking-empty", empty]]);
  new Script(script).runInNewContext({ document: {
    getElementById: (id: string) => elements.get(id), querySelectorAll: () => [],
  }, addEventListener: () => {} });
  sort();
  assert.deepEqual(rendered.map(row => row.cells[4].textContent), ["-5", "9", "80"]);
  assert.equal(attributes.get("aria-sort"), "ascending");
  sort();
  assert.deepEqual(rendered.map(row => row.cells[4].textContent), ["80", "9", "-5"]);
  search.value = " bBb ";
  filter();
  assert.deepEqual(rows.map(row => row.hidden), [true, false, true]);
  assert.equal(count.textContent, "1 מניות");
  search.value = "לא קיים";
  filter();
  assert.equal(empty.hidden, false);
  search.value = "";
  filter();
  assert.equal(count.textContent, "3 מניות");
  assert.equal(empty.hidden, true);
});