import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { renderReportHtml, type ReportHtmlInput } from "../src/html.js";
import { generateReport } from "../src/report.js";
import type { AnalysisResult } from "../src/analysis.js";
import { buildReportSummary, buildReportSummarySnapshot } from "../src/summary.js";
import { PORTFOLIO, type HoldingDef } from "../src/config.js";
import { buildBriefActions } from "../src/brief.js";

test("brief actions preserve sell thresholds and explain weaker watch cautions without classifying missing funds", () => {
  const input = reportInput();
  const held = stock("DSCT.TA", 10);
  held.price = 3600;
  input.results = [held];
  let actions = buildBriefActions(input);
  assert.equal(actions.sell.length, 0);
  assert.match(actions.watch.join(" "), /חלש/);
  assert.doesNotMatch(actions.watch.join(" "), /סטופ הדוק/);
  held.score = 50;
  held.signals = ["שבירת רצף עולה"];
  actions = buildBriefActions(input);
  assert.equal(actions.sell.length, 0);
  assert.match(actions.watch.join(" "), /סטופ הדוק/);
  held.patterns = [{ name: "דובי", bias: "bearish" } as AnalysisResult["patterns"][number]];
  actions = buildBriefActions(input);
  assert.equal(actions.sell.length, 1);
  assert.match(actions.sell[0], /צמצום לבדיקה/);
  assert.equal(actions.watch.length, 0);
  held.signals.push("קרוס דובי");
  actions = buildBriefActions(input);
  assert.match(actions.sell[0], /מכירה \/ יציאה לבדיקה/);
  assert.equal(actions.missing.length, 2);
  assert.ok(actions.missing.every(entry => entry.includes("ללא כיסוי טכני")));
  assert.ok(actions.buy.every(entry => !entry.includes("DSCT.TA")));
});

test("brief labels sequence stop, risk stop, score and delta separately to prevent mixed-direction ambiguity", () => {
  const input = reportInput();
  input.results = [stock("DSCT.TA")];
  const html = renderReportHtml(input);
  const brief = html.slice(html.indexOf('id="portfolio-brief"'), html.indexOf('<nav class="section-nav"'));
  assert.match(brief, /<dt>סטופ רצף<\/dt><dd[^>]*><bdi>91<\/bdi>/);
  assert.match(brief, /<dt>סטופ סיכון<\/dt><dd[^>]*><bdi>לא זמין<\/bdi>/);
  assert.match(brief, /<dt>ציון<\/dt><dd[^>]*><bdi>50<\/bdi>/);
  assert.match(brief, /<dt>שינוי ציון<\/dt><dd[^>]*><bdi>לא זמין<\/bdi>/);
});

const testPortfolio: HoldingDef[] = [
  { symbol: "DSCT.TA", name: "בנק דיסקונט", entryPrice: 3314.74 },
  { name: "קסם S&P Energy ETF", taseNumber: "1145903", entryPrice: 4502,
    investingUrl: "https://www.investing.com/etfs/ksm-4d-sp-energy" },
  { name: "הראל ביטחוניות", taseNumber: "1233170", entryPrice: 4749.19,
    investingUrl: "https://www.investing.com/etfs/hrlf238", triggerIndex: "207.TA" },
];
let originalPortfolio: HoldingDef[];

beforeEach(() => {
  originalPortfolio = PORTFOLIO.slice();
  PORTFOLIO.splice(0, PORTFOLIO.length, ...structuredClone(testPortfolio));
});

afterEach(() => {
  PORTFOLIO.splice(0, PORTFOLIO.length, ...originalPortfolio);
});

function stock(symbol = "TEST.TA", score = 50): AnalysisResult {
  return {
    symbol, name: `מניה ${symbol}`, price: 100, score, recommendation: "קנייה",
    signals: [], patterns: [], liquidityNote: "גבוהה", sequenceStop: 91,
    risk: null, size: null, levels: { support: null, resistance: null },
    relativeStrength: null, divergence: null, earningsInDays: null,
    fundamentals: null, newsSentiment: 0,
    indicators: { rsi: 50, macdHist: null, percentB: null, smaShort: null, smaLong: null,
      trendUp: true, stochK: 50, stochD: null, williamsR: null, atrPct: null,
      adx: null, obvTrendUp: null, cci: null, mfi: null, roc: null, vwap: null,
      supertrendUp: null, ichimokuPosition: null, chandelier: null },
  };
}

function snapshotOf(html: string) {
  const embedded = /<script type="application\/json" id="report-summary">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(embedded, "Missing embedded report summary");
  return JSON.parse(embedded[1]);
}

function cli(html: string, top = 5): string {
  return execFileSync(process.execPath, ["tools/report-summary.mjs", "--file=-", `--top=${top}`], {
    cwd: new URL("../", import.meta.url), input: html, encoding: "utf8",
  });
}

function reportInput(): ReportHtmlInput {
  return {
    mode: "daily", results: [], indices: [], newsByStock: new Map(),
    generatedAt: new Date("2026-09-07T12:00:00Z"),
    forecast: { horizon: "היום", summary: "סקירה", markets: [],
      newsTone: { positive: 0, negative: 0, neutral: 0, label: "ניטרלי" } },
  };
}

test("zero analyzed results reject before changing reports, summaries or histories", async () => {
  const root = mkdtempSync(join(tmpdir(), "report-summary-"));
  const original = process.cwd();
  mkdirSync(join(root, "reports"));
  const originals = {
    "reports/report-daily-2026-09-07.html": "original report",
    "reports/latest-daily.txt": "original summary",
    "reports/score-history.json": '{"daily":{"2026-09-06":{"TEST.TA":42}}}',
    "index.html": "original index",
  };
  for (const [file, content] of Object.entries(originals)) writeFileSync(join(root, file), content);
  try {
    process.chdir(root);
    await assert.rejects(generateReport({ ...reportInput(), allNews: [] }), /אין.*תוצאות|zero analyzed/i);
    for (const [file, content] of Object.entries(originals)) assert.equal(readFileSync(join(root, file), "utf8"), content);
    assert.deepEqual(readdirSync(join(root, "reports")).sort(), ["latest-daily.txt", "report-daily-2026-09-07.html", "score-history.json"]);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTML embeds a report-time summary snapshot including quote-only holdings", () => {
  const html = renderReportHtml(reportInput());
  const embedded = /<script type="application\/json" id="report-summary">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(embedded, "Missing embedded report summary");
  const snapshot = JSON.parse(embedded[1]);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.generatedAt, "2026-09-07T12:00:00.000Z");
  assert.match(snapshot.summary, /1145903/);
  assert.match(snapshot.summary, /4502/);
  assert.match(snapshot.summary, /אין תוצאות ניתוח/);
});

test("summary distinguishes partial collection, old daily bars and quote-only coverage", () => {
  const input = {
    ...reportInput(), results: [stock("DSCT.TA")],
    extraPrices: new Map([["קסם S&P Energy ETF", 4502]]),
    prevScores: new Map([["DSCT.TA", 47]]),
    dataHealth: { expected: 3, analyzed: 1,
      latestBarDates: { "DSCT.TA": "2026-09-04", "SHORT.TA": "2026-09-03", "MISSING.TA": null },
      missingSymbols: ["SHORT.TA", "MISSING.TA"],
      failures: { "SHORT.TA": "אין מספיק נתונים", "MISSING.TA": "HTTP 429" }, warnings: ["מקור חסר"] },
  };
  const html = renderReportHtml(input);
  const snapshot = snapshotOf(html);
  assert.match(snapshot.summary, /איסוף חלקי.*1.*3/);
  assert.match(snapshot.summary, /DSCT\.TA.*2026-09-04/);
  assert.match(snapshot.summary, /נרות מתאריכים קודמים/);
  assert.match(snapshot.summary, /SHORT\.TA.*אין מספיק נתונים/);
  assert.match(snapshot.summary, /MISSING\.TA.*HTTP 429/);
  assert.match(snapshot.summary, /זמן ההפקה אינו זמן הציטוט/);
  assert.match(snapshot.summary, /ציון 50.*Δ \+3.*סטופ רצף 91/);
  const energy = snapshot.portfolio.find((holding: { taseNumber: string }) => holding.taseNumber === "1145903");
  assert.equal(energy.entryPrice, 4502);
  assert.equal(energy.price, 4502);
  assert.equal(energy.returnPct, 0);
  assert.equal(energy.score, undefined);
  assert.equal(energy.stop, undefined);
  assert.equal(energy.sequenceStop, undefined);
  assert.match(snapshot.summary, /מחיר בלבד.*ללא ניתוח טכני.*אין ציון או סטופ/);
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, "");
  assert.match(visible, /id="data-health"/);
  assert.match(visible, /איסוף חלקי/);
  assert.match(visible, /2026-09-04/);
  assert.doesNotMatch(visible, /כל הפוזיציות מעל רמות היציאה/);
});

test("a quote failure remains a partial collection even when every expected stock was analyzed", () => {
  const input = { ...reportInput(), results: [stock()],
    dataHealth: { expected: 1, analyzed: 1, latestBarDates: { "TEST.TA": "2026-09-07" },
      missingSymbols: [], failures: { "1145903": "מחיר לא זמין" }, warnings: [] } };
  const summary = buildReportSummary(input);
  assert.match(summary, /איסוף חלקי.*1 מתוך 1/);
  assert.match(summary, /1145903: מחיר לא זמין/);
  assert.doesNotMatch(summary, /נרות מתאריכים קודמים/);
});

test("summary uses existing pick filters, combined ranking, alternates and available index evidence", () => {
  const results = [stock("DSCT.TA", 70), stock("BEST.TA", 60), stock("ALT.TA", 65), stock("NEXT.TA", 75), stock("REJECT.TA", 90)];
  for (const result of results) result.risk = { stop: 90, stopSource: "רצפים", riskPct: 10, target: 120, targetSource: "2R", rr: 2 };
  results[4].earningsInDays = 1;
  const input: ReportHtmlInput = { ...reportInput(), results,
    horizons: new Map(results.map((result, index) => [result.symbol, {
      weeklyScore: null, weeklyRec: null, longTerm: null, combined: [95, 85, 80, 75, 100][index], alignment: "חלקית",
    }])),
    indices: [{ symbol: "^NDX", name: "נאסדק", region: 'ארה"ב', price: 12345, changePct: -1.5,
      score: -10, stance: "ניטרלי", recommendation: "מעקב", signals: [],
      indicators: { rsi: null, macdHist: null, adx: null, roc: null, atrPct: null, trendUp: false, aboveSmaLong: false } }],
  };
  const summary = buildReportSummary(input);
  const pick = summary.split("===== המלצת הרכישה =====")[1].split("===== תחזית ומדדים =====")[0];
  assert.match(pick, /^\nמניה BEST\.TA.*משולב 85.*סטופ 90.*יעד 120.*סיכוי\/סיכון 2/);
  assert.match(pick, /חלופה: מניה ALT\.TA/);
  assert.match(pick, /חלופה: מניה NEXT\.TA/);
  assert.match(pick, /חיזוק החזקה:.*DSCT\.TA/);
  assert.doesNotMatch(pick, /REJECT\.TA/);
  const top = summary.split("===== 5 המובילות בטבלה")[1];
  assert.ok(top.indexOf("REJECT.TA") < top.indexOf("DSCT.TA"));
  assert.match(summary, /נאסדק \(\^NDX\).*12345.*-1.5%.*-10/);
  assert.match(summary, /תחזית היוריסטית, לא הסתברות מכוילת/);
  assert.match(summary, /שבועי לא זמין/);
});

test("full digest and detailed pick never recommend strengthening a holding with active caution or reduction signals", () => {
  const held = stock("DSCT.TA", 70);
  held.risk = { stop: 90, stopSource: "רצפים", riskPct: 10, target: 120, targetSource: "2R", rr: 2 };
  const input: ReportHtmlInput = { ...reportInput(), results: [held],
    horizons: new Map([[held.symbol, { weeklyScore: 70, weeklyRec: "קנייה", longTerm: null, combined: 95, alignment: "חלקית" }]]) };
  assert.match(buildReportSummary(input), /חיזוק החזקה:/);
  assert.match(renderReportHtml(input), /class="pick-strength"/);
  for (const signals of [["שבירת רצף עולה"], ["שבירת רצף עולה", "קרוס דובי"]]) {
    held.signals = signals;
    const summary = buildReportSummary(input);
    assert.doesNotMatch(summary, /חיזוק החזקה:/);
    assert.doesNotMatch(renderReportHtml(input), /class="pick-strength"/);
    assert.ok(!buildBriefActions(input).buy.length);
  }
});

test("summary is deterministic and its saved portfolio is independent of later configuration edits", () => {
  const input = { ...reportInput(), results: [stock("DSCT.TA")] };
  const snapshot = buildReportSummarySnapshot(input);
  assert.equal(buildReportSummary(input), snapshot.summary);
  assert.equal(buildReportSummary(input), buildReportSummary(input));
  const energy = PORTFOLIO.find((holding) => holding.taseNumber === "1145903")!;
  const original = energy.entryPrice;
  try {
    energy.entryPrice = 9999;
    assert.equal(snapshot.portfolio.find((holding) => holding.taseNumber === "1145903")!.entryPrice, 4502);
    assert.doesNotMatch(snapshot.summary, /9999/);
    const html = `<script type="application/json" id="report-summary">${JSON.stringify(snapshot)}</script>`;
    assert.ok(cli(html).includes(snapshot.summary));
  } finally { energy.entryPrice = original; }
});

test("snapshot CLI ignores later HTML and preserves --top including zero and more than five", () => {
  const input = { ...reportInput(), results: Array.from({ length: 7 }, (_, index) => stock(`RANK${index}.TA`, 70 - index)) };
  const html = renderReportHtml(input);
  const snapshot = snapshotOf(html);
  const embeddedOnly = html.match(/<script type="application\/json" id="report-summary">[\s\S]*?<\/script>/)![0];
  const changedHtml = `${embeddedOnly}<p class="generated">LATER DATE</p><section><h2>התיק שלי</h2><p>CHANGED PORTFOLIO</p></section>`;
  assert.ok(cli(changedHtml).includes(snapshot.summary));
  assert.doesNotMatch(cli(changedHtml), /CHANGED PORTFOLIO|LATER DATE/);
  const five = cli(changedHtml);
  const topFive = five.slice(five.lastIndexOf("===== 5"));
  assert.match(topFive, /RANK4\.TA/);
  assert.doesNotMatch(topFive, /RANK5\.TA/);
  const seven = cli(changedHtml, 7);
  assert.match(seven.slice(seven.lastIndexOf("===== 7")), /RANK6\.TA/);
  assert.doesNotMatch(cli(changedHtml, 0), /המובילות בטבלה/);
});

test("summaries keep untrusted text inert and use actual bearish signals even with a positive score", () => {
  const result = { ...stock("DSCT.TA", 70), name: '</script><img src=x onerror="bad()">',
    signals: ["שבירת רצף עולה", "קרוס דובי"] };
  const html = renderReportHtml({ ...reportInput(), results: [result] });
  const snapshot = snapshotOf(html);
  assert.doesNotMatch(html, /<img src=x|<\/script><img/);
  assert.doesNotMatch(snapshot.summary, /<[^>]+>/);
  assert.match(snapshot.summary, /התראות סיכון שמרניות/);
  assert.match(snapshot.summary, /DSCT\.TA.*שבירת רצף עולה/);
  assert.match(snapshot.summary, /קרוס דובי/);
});

test("daily and weekly summaries are persisted exactly as their HTML snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "report-summary-save-"));
  const original = process.cwd();
  try {
    process.chdir(root);
    for (const mode of ["daily", "weekly"] as const) {
      const file = await generateReport({ ...reportInput(), mode, results: [stock()], allNews: [] });
      const snapshot = snapshotOf(readFileSync(file, "utf8"));
      assert.equal(readFileSync(join(root, "reports", `latest-${mode}.txt`), "utf8"), `${snapshot.summary}\n`);
      assert.equal(snapshot.mode, mode);
      const receipt = JSON.parse(readFileSync(join(root, ".cache", `report-${mode}.json`), "utf8"));
      assert.equal(receipt.mode, mode);
      assert.equal(receipt.generatedAt, snapshot.generatedAt);
      assert.match(receipt.fileName, new RegExp(`^report-${mode}-2026-09-07\\.html$`));
      assert.match(receipt.htmlHash, /^[a-f0-9]{64}$/);
      assert.match(receipt.digestHash, /^[a-f0-9]{64}$/);
    }
    assert.ok(readFileSync(join(root, "reports", "latest-daily.txt"), "utf8").includes("יומי"));
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy summary gets held symbols from the report and tolerates a broken snapshot", () => {
  const html = `<script type="application/json" id="report-summary">{broken}</script>
    <section class="portfolio"><h2>התיק שלי</h2><table><tbody>
    <tr><td class="name">החזקה ישנה <small>OLD.TA</small></td></tr></tbody></table></section>
    <section><h2>פירוט מלא לכל המניות</h2><details class="detail"><summary><strong>החזקה ישנה</strong><small>OLD.TA</small></summary><p>OLD SIGNAL</p></details></section>`;
  const output = cli(html, 0);
  assert.match(output, /--- OLD\.TA ---[\s\S]*OLD SIGNAL/);
  assert.doesNotMatch(output, /--- DSCT\.TA ---/);
});

test("runner captures actual daily bar dates, missing analyses and quote failures in both modes", () => {
  const root = mkdtempSync(join(tmpdir(), "report-summary-runner-"));
  const source = new URL("../src/", import.meta.url).href;
  const script = `
    import { mock } from 'node:test';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const config = await import(${JSON.stringify(`${source}config.ts`)});
    const energy = { name: 'קסם S&P Energy ETF', taseNumber: '1145903', entryPrice: 4502,
      investingUrl: 'https://www.investing.com/etfs/ksm-4d-sp-energy' };
    const defense = { name: 'הראל ביטחוניות', taseNumber: '1233170', entryPrice: 4749.19,
      investingUrl: 'https://www.investing.com/etfs/hrlf238', triggerIndex: '207.TA' };
    config.WATCHLIST.splice(0, config.WATCHLIST.length,
      { symbol: 'DSCT.TA', name: 'בנק דיסקונט' },
      { symbol: 'SHORT.TA', name: 'היסטוריה קצרה' },
      { symbol: 'FAIL.TA', name: 'ספק חסר' });
    config.PORTFOLIO.splice(0, config.PORTFOLIO.length,
      { symbol: 'DSCT.TA', name: 'בנק דיסקונט', entryPrice: 3314.74 }, energy, defense);
    let empty = false;
    const daily = Array.from({ length: 350 }, (_, index) => ({
      date: new Date(Date.parse('2026-09-04T12:00:00Z') - (349 - index) * 86400000),
      open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index, volume: 1000000,
    }));
    const data = await import(${JSON.stringify(`${source}data.ts`)});
    mock.module(${JSON.stringify(`${source}data.ts`)}, { namedExports: { ...data,
      ensureTls: async () => {},
      fetchCandles: async symbol => {
        if (empty) return [];
        if (symbol === 'FAIL.TA') throw new Error('HTTP 429');
        if (symbol === 'DSCT.TA') return daily;
        if (symbol === 'SHORT.TA') return daily.slice(-3, -2);
        return [];
      },
      fetchInvestingPrice: async url => { if (url === energy.investingUrl) return 4502; throw new Error('quote unavailable'); },
      fetchTasePrice: async () => null,
    }});
    const news = await import(${JSON.stringify(`${source}news.ts`)});
    mock.module(${JSON.stringify(`${source}news.ts`)}, { namedExports: { ...news, fetchAllNews: async () => [] }});
    const fundamentals = await import(${JSON.stringify(`${source}fundamentals.ts`)});
    mock.module(${JSON.stringify(`${source}fundamentals.ts`)}, { namedExports: { ...fundamentals, getFundamentals: async () => null }});
    const indices = await import(${JSON.stringify(`${source}indices.ts`)});
    mock.module(${JSON.stringify(`${source}indices.ts`)}, { namedExports: { ...indices, analyzeWorldIndices: async () => [] }});
    const { runAnalysis } = await import(${JSON.stringify(`${source}runner.ts`)});
    process.chdir(${JSON.stringify(root)});
    const output = console.log;
    console.log = () => {};
    const runs = [];
    for (const mode of ['daily', 'weekly']) {
      const result = await runAnalysis(mode);
      const html = readFileSync(result.reportPath, 'utf8');
      const snapshot = JSON.parse(html.match(/<script type="application\\/json" id="report-summary">([\\s\\S]*?)<\\/script>/)[1]);
      runs.push({ health: result.dataHealth, snapshot });
    }
    const retained = readFileSync(join('reports', 'state.sqlite')).toString('base64');
    const summary = readFileSync(join('reports', 'latest-daily.txt'), 'utf8');
    empty = true;
    let rejected = false;
    try { await runAnalysis('daily'); } catch (error) { rejected = /אין.*תוצאות|zero analyzed/i.test(error.message); }
    output(JSON.stringify({ runs, rejected, preserved: retained === readFileSync(join('reports', 'state.sqlite')).toString('base64'),
      summaryPreserved: summary === readFileSync(join('reports', 'latest-daily.txt'), 'utf8') }));
  `;
  try {
    const output = execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL("../", import.meta.url), encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    });
    const fixture = JSON.parse(output);
    for (const run of fixture.runs) {
      assert.equal(run.health.expected, 3);
      assert.equal(run.health.analyzed, 1);
      assert.equal(run.health.latestBarDates["DSCT.TA"], "2026-09-04");
      assert.equal(run.health.latestBarDates["SHORT.TA"], "2026-09-02");
      assert.equal(run.health.latestBarDates["FAIL.TA"], null);
      assert.deepEqual(run.health.missingSymbols, ["SHORT.TA", "FAIL.TA"]);
      assert.match(run.health.failures["SHORT.TA"], /אין מספיק נתונים/);
      assert.match(run.health.failures["FAIL.TA"], /HTTP 429/);
      assert.match(run.health.failures["1233170"], /quote unavailable/);
      assert.match(run.snapshot.summary, /איסוף חלקי/);
      assert.match(run.snapshot.summary, /1145903.*4502/);
      assert.deepEqual(run.snapshot.dataHealth, run.health);
    }
    assert.equal(fixture.rejected, true);
    assert.equal(fixture.preserved, true);
    assert.equal(fixture.summaryPreserved, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});