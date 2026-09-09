import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { afterEach, beforeEach } from "node:test";
import { buildIndexHtml, renderReportHtml, type ReportHtmlInput } from "../src/html.js";
import type { HistoricalForecast } from "../src/forecast.js";
import { Script } from "node:vm";
import { PORTFOLIO, type HoldingDef } from "../src/config.js";

const testPortfolio: HoldingDef[] = [
  { symbol: "DSCT.TA", name: "בנק דיסקונט", entryPrice: 3314.74 },
  { name: "קסם S&P Energy ETF", taseNumber: "1145903", entryPrice: 4502,
    investingUrl: "https://www.investing.com/etfs/ksm-4d-sp-energy" },
];
let originalPortfolio: HoldingDef[];

beforeEach(() => {
  originalPortfolio = PORTFOLIO.slice();
  PORTFOLIO.splice(0, PORTFOLIO.length, ...structuredClone(testPortfolio));
});

afterEach(() => {
  PORTFOLIO.splice(0, PORTFOLIO.length, ...originalPortfolio);
});

function reportInput(): ReportHtmlInput {
  return {
    mode: "daily", results: [], indices: [], newsByStock: new Map(),
    generatedAt: new Date("2026-09-06T12:00:00Z"),
    forecast: { horizon: "היום", summary: "סקירה", markets: [],
      newsTone: { positive: 0, negative: 0, neutral: 0, label: "ניטרלי" } },
  };
}

test("portfolio brief precedes navigation and keeps missing holdings unclassified", () => {
  const html = renderReportHtml(reportInput());
  const start = html.indexOf('id="portfolio-brief"');
  assert.ok(start > 0, "Expected an always-visible portfolio brief");
  assert.ok(start < html.indexOf('<nav class="section-nav"'));
  const brief = html.slice(start, html.indexOf('<nav class="section-nav"'));
  for (const label of ["קנייה / חיזוק", "מכירה / צמצום", "החזקה / מעקב", "ללא כיסוי טכני", "בנק דיסקונט", "1145903"])
    assert.ok(brief.includes(label), label);
  assert.match(brief, /id="ai-report-narrative"/);
  assert.doesNotMatch(brief, /רווח כולל|שווי התיק/);
  assert.match(brief, /אין החזקות שנותחו/);
});

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

test("index adds install assets and an in-site Hebrew management guide without moving the inline script", () => {
  const html = buildIndexHtml([{ mode: "daily", date: "2026-09-07", file: "reports/report-daily-2026-09-07.html" }]);
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /<meta name="theme-color" content="#23734e"/);
  assert.match(html, /id="install-app"/);
  assert.match(html, /id="app-help"/);
  assert.match(html, /id="open-app-help"/);
  assert.match(html, /id="close-app-help"/);
  assert.match(html, /id="help-management"/);
  assert.match(html, /id="app-status"/);
  assert.match(html, /Chrome ב-Android/);
  assert.match(html, /Actions > Manage & Build Reports > Run workflow/);
  assert.match(html, /portfolio/);
  assert.match(html, /watchlist/);
  assert.match(html, /action/);
  assert.match(html, /mode/);
  assert.match(html, /target/);
  assert.match(html, /identifier/);
  assert.match(html, /name/);
  assert.match(html, /entry_price/);
  assert.match(html, /sector/);
  assert.match(html, /investing_url/);
  assert.match(html, /alert_below/);
  assert.match(html, /trigger_index/);
  assert.match(html, /שדה ריק פירושו ללא שינוי/);
  assert.match(html, /'-' מנקה שדה אופציונלי/);
  assert.match(html, /latest-daily\.txt/);
  assert.match(html, /latest-weekly\.txt/);
  assert.match(html, /UTC/);
  assert.match(html, /שעון ישראל/);
  const inlineIndex = html.indexOf("<script>\nconst REPORTS =");
  const externalIndex = html.indexOf('<script src="./app.js" defer></script>');
  assert.ok(inlineIndex >= 0, "Inline index script must remain first for existing extraction tests");
  assert.ok(externalIndex > inlineIndex, "External app script must load after the inline script");
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

test("report navigation reaches operational sections before the collapsed buy catalog", () => {
  const html = renderReportHtml({ ...reportInput(), extraPrices: new Map([["קסם S&P Energy ETF", 4502]]) });
  const navigation = /<nav\b[^>]*aria-label="ניווט בדוח"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  assert.ok(navigation, "Report needs section navigation");
  for (const id of ["summary", "alerts", "portfolio", "rankings", "evidence"]) {
    assert.ok(navigation[1].includes(`href="#${id}"`), `Missing link to ${id}`);
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, `One target for ${id}`);
  }
  assert.ok(html.indexOf('id="alerts"') < html.indexOf('id="portfolio"'));
  assert.ok(html.indexOf('id="portfolio"') < html.indexOf('id="evidence"'));
  const catalog = /<details\b([^>]*id="buy-catalog"[^>]*)>/.exec(html);
  assert.ok(catalog, "Full buy catalog remains available");
  assert.doesNotMatch(catalog[1], /\bopen\b/);
  assert.doesNotMatch(html, /class="hero"/);
  assert.doesNotMatch(html, /<h[1-6][^>]*>\s*[💼🧭📈🔗🔻🛒🌍🎯]/u);
  assert.match(html, /בהחזקות שנותחו/);
  assert.match(html, /מחיר בלבד[^<]*ללא ציון או סטופ/);
  assert.doesNotMatch(html, /כל ההחזקות מעל רמות היציאה/);
});

test("executive summary stays concise while health dates and the full snapshot remain available", () => {
  const input = reportInput();
  input.dataHealth = { expected: 119, analyzed: 118, missingSymbols: ["MISSING.TA"],
    latestBarDates: Object.fromEntries(Array.from({ length: 119 }, (_, index) => [`STOCK${index}.TA`, "2026-09-04"])),
    failures: { "MISSING.TA": "אין נתונים <script>" }, warnings: ["איסוף חלקי"] };
  const html = renderReportHtml(input);
  const executive = /<div\b[^>]*id="report-summary-text"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(executive, "Visible executive summary is required");
  assert.ok(executive[1].length < 2200, "Executive summary must not repeat all bar dates");
  assert.doesNotMatch(executive[1], /STOCK118/);
  assert.match(executive[1], /118/);
  const freshness = /<[^>]*id="data-freshness"[^>]*>([\s\S]*?)<\//.exec(html);
  assert.ok(freshness);
  assert.match(freshness[1], /2026-09-04/);
  const details = /<details\b([^>]*id="health-details"[^>]*)>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(details);
  assert.doesNotMatch(details[1], /\bopen\b/);
  assert.match(details[2], /STOCK118/);
  const snapshot = JSON.parse(/<script type="application\/json" id="report-summary">([\s\S]*?)<\/script>/.exec(html)![1]);
  assert.equal(snapshot.dataHealth.expected, 119);
  assert.equal(snapshot.dataHealth.latestBarDates["STOCK118.TA"], "2026-09-04");
  assert.ok(snapshot.summary.includes("STOCK118.TA"));
  assert.match(html, /id="full-summary"/);
  assert.doesNotMatch(html, /אין נתונים <script>/);
});

function indexFixture(repository: string | undefined, address: string, entries: Parameters<typeof buildIndexHtml>[0] = []) {
  const previous = process.env.GITHUB_REPOSITORY;
  let html: string;
  try {
    if (repository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = repository;
    html = buildIndexHtml(entries);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous;
  }
  const nodes: ReturnType<typeof element>[] = [];
  function element() {
    const attributes = new Map<string, string>();
    const children: ReturnType<typeof element>[] = [];
    const node = { attributes, children, hidden: false, disabled: false, textContent: "", innerHTML: "", href: "", src: "",
      className: "", tabIndex: 0, style: { display: "" }, onclick: () => {}, focus: () => {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild: (child: ReturnType<typeof element>) => { children.push(child); },
      get firstChild() { return children[0]; },
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      getAttribute: (name: string) => attributes.get(name),
      removeAttribute: (name: string) => { attributes.delete(name); if (name === "src") node.src = ""; },
      addEventListener: () => {} };
    nodes.push(node);
    return node;
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
  const requests: { url: string; method: string }[] = [];
  const context = { document: {
    getElementById: (id: string) => elements.get(id), querySelector: () => element(),
    querySelectorAll: (selector: string) => selector === ".run-btn"
      ? [elements.get("run-daily"), elements.get("run-weekly")]
      : nodes.filter(node => node.className === "report-item"),
    createElement: () => element(),
  }, location: Object.assign(new URL(address), { reload: () => {} }),
  fetch: async (url: string, options: { method: string }) => {
    requests.push({ url, method: options.method });
    return { ok: true, json: async () => ({ ok: true }) };
  }, setTimeout: () => {} };
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  new Script(script).runInNewContext(context);
  return { html, elements, requests, context };
}

test("configured workflow manager works on custom domains and downloaded reports without local API calls", async () => {
  for (const address of ["https://finance.example.org/", "file:///C:/reports/index.html"]) {
    const fixture = indexFixture("analyst/market-reports", address);
    const manager = fixture.elements.get("manage-reports");
    assert.ok(manager, "Authenticated workflow manager link is required");
    assert.equal(manager.href, "https://github.com/analyst/market-reports/actions/workflows/reports.yml");
    assert.equal(manager.hidden, false);
    await new Script("runReport('daily')").runInNewContext(fixture.context);
    assert.deepEqual(fixture.requests, []);
    assert.equal(fixture.elements.get("run-daily")!.hidden, true);
  }
});

test("Pages inference validates host and repository and never creates an unsafe management URL", async () => {
  for (const [repository, address, expected] of [
    [undefined, "https://analyst.github.io/market-reports/", "https://github.com/analyst/market-reports/actions/workflows/reports.yml"],
    [undefined, "https://analyst.github.io/", "https://github.com/analyst/analyst.github.io/actions/workflows/reports.yml"],
    ["../bad", "https://finance.example.org/", ""],
    ["owner/repo\"<script>", "file:///C:/index.html", ""],
    [undefined, "https://evilgithub.io/reports/", ""],
    [undefined, "https://analyst.github.io/%22%3E%3Cscript%3E/", ""],
    [undefined, "https://analyst.github.io/../", "https://github.com/analyst/analyst.github.io/actions/workflows/reports.yml"],
  ]) {
    const fixture = indexFixture(repository, address!);
    const manager = fixture.elements.get("manage-reports");
    assert.ok(manager);
    assert.equal(manager.href, expected);
    assert.equal(manager.hidden, !expected);
    await new Script("runReport('weekly')").runInNewContext(fixture.context);
    assert.deepEqual(fixture.requests, []);
  }
});

test("localhost keeps POST generation and archive selection clears an empty mode", async () => {
  const fixture = indexFixture("analyst/market-reports", "http://localhost:3000/", [
    { mode: "daily", date: "2026-09-06", file: "reports/report-daily-2026-09-06.html" },
    { mode: "daily", date: "2026-09-07", file: "reports/report-daily-2026-09-07.html" },
  ]);
  assert.equal(fixture.elements.get("frame")!.src, "reports/report-daily-2026-09-07.html");
  assert.equal(fixture.elements.get("run-daily")!.hidden, false);
  await new Script("runReport('daily')").runInNewContext(fixture.context);
  assert.deepEqual(fixture.requests, [{ url: "/api/run?mode=daily", method: "POST" }]);
  new Script("setMode('weekly')").runInNewContext(fixture.context);
  assert.equal(fixture.elements.get("frame")!.src, "");
  assert.equal(fixture.elements.get("empty-state")!.style.display, "flex");
});