import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentStore } from "../src/storage.js";
import {
  fetchCandles, getRateLimitHits, normalizeUnitSwitches, barDates, findStaleSymbols, mapPool, type Candle,
} from "../src/data.js";
import { rawFactors, percentileRanks, scoreUniverse, leverageTrigger, hybridRecommendation, evaluateEngine, describeEngine, macroFlags, geoHeadlineIntensity, isGeoHeadline, appendGeoHistory, sensitivityMatrix, leverageOf, rsRatings, accumulationRatio, topUpZone, pivotExtension, underlyingStatus, underlyingText, type RawFactors, type ValidationRow } from "../src/engine.js";
import { dedupeNews, parseYoutubeFeed, splitDescription, markNewVideos, findMentions, containsHebrewWord, methodVerdict, buildCreatorView, parseChannelPage, parseWatchPage, rememberVideos, methodCheck, methodPassLine, holdingVerdict, sectorConcentration, type NewsItem, type CreatorVideo } from "../src/news.js";
import { trendChangeSetup } from "../src/indicators.js";
import { renderCreatorSection, renderFundIndexSection, renderMarketRecsSection, type ReportHtmlInput } from "../src/html.js";
import { fundDecision, fundLevels, analyzeFundIndex, marketOf, type FundIndexView } from "../src/engine.js";
import { marketRecommendations } from "../src/brief.js";
import { fetchIndexHistory } from "../src/indices.js";
import type { MethodCheck } from "../src/news.js";
import type { LeverageTrigger } from "../src/engine.js";
import type { EvidenceGrades } from "../src/grades.js";
import { analyzeStock, buildHorizonInfo, type AnalysisResult, type HorizonInfo, type Recommendation } from "../src/analysis.js";
import { selectDailyPick } from "../src/pick.js";
import type { MarketRegime } from "../src/regime.js";
import { parseFundamentals, type Fundamentals, type CrowdData } from "../src/fundamentals.js";
import {
  letterOf, gradeUniverse, redFlags, gradeChips, gradeWhy, evaluateGradeHistory, describeGradeValidation, appendGradeHistory, starRating,
  type GradeHistory,
} from "../src/grades.js";
import type { Candle } from "../src/data.js";
import type { FactorScore } from "../src/engine.js";
const EMPTY_NEWS = { items: [], totalSentiment: 0, freshNegative: [] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- candle quality ----------------------------- */

const bars = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ date: new Date(Date.UTC(2026, 4, 1 + i)), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }));

test("normalizeUnitSwitches rescales history before a ×100 unit switch", () => {
  const out = normalizeUnitSwitches(bars([285, 287, 290, 29250, 29400]));
  assert.deepEqual(out.map((c) => Math.round(c.close)), [28500, 28700, 29000, 29250, 29400]);
  assert.equal(Math.round(out[0].high), Math.round(285 * 1.01 * 100));
  assert.equal(out[0].volume, 1000);
});

test("normalizeUnitSwitches handles a ÷100 switch", () => {
  const out = normalizeUnitSwitches(bars([22000, 22100, 222.3, 224]));
  assert.deepEqual(out.map((c) => Number(c.close.toFixed(1))), [220, 221, 222.3, 224]);
});

test("normalizeUnitSwitches leaves clean series and genuine large moves untouched", () => {
  const clean = bars([100, 101, 99, 102]);
  assert.deepEqual(normalizeUnitSwitches(clean), clean);
  const crash = bars([100, 60, 30, 31]);
  assert.deepEqual(normalizeUnitSwitches(crash), crash);
  const noisy = bars([100, 140, 14000, 5000]);
  assert.deepEqual(normalizeUnitSwitches(noisy), noisy);
});

test("findStaleSymbols flags .TA stocks whose last or previous bar lags the benchmark", () => {
  const bench = { last: "2026-10-16", prev: "2026-10-15" };
  const map = new Map([
    ["OK.TA", { last: "2026-10-16", prev: "2026-10-15" }],
    ["LAG.TA", { last: "2026-10-15", prev: "2026-10-14" }],
    ["GAP.TA", { last: "2026-10-16", prev: "2026-10-14" }],
    ["NVDA", { last: "2026-10-15", prev: "2026-10-14" }],
  ]);
  assert.deepEqual(findStaleSymbols(map, bench), ["LAG.TA", "GAP.TA"]);
  assert.deepEqual(barDates(bars([1, 2, 3])), { last: "2026-05-03", prev: "2026-05-02" });
  assert.deepEqual(barDates([]), { last: null, prev: null });
});

test("fetchCandles normalizes a cached ×100 unit switch without network access", async () => {
  const root = mkdtempSync(join(tmpdir(), "candles-"));
  const original = process.cwd();
  try {
    process.chdir(root);
    const store = new DocumentStore(join(root, ".cache", "candles.sqlite"));
    const closes = [285, 287, 290, 29250, 29400];
    store.set("candle:UNIT.TA", {
      symbol: "UNIT.TA", days: 730, fetchedAt: Date.now(),
      candles: closes.map((c, i) => [new Date(Date.UTC(2026, 4, 1 + i)).toISOString(), c, c, c, c, 10]),
    });
    store.close();
    const candles = await fetchCandles("UNIT.TA", 730);
    assert.deepEqual(candles.map((c) => Math.round(c.close)), [28500, 28700, 29000, 29250, 29400]);
    assert.equal(getRateLimitHits(), 0);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------- fetch pool ----------------------------- */

test("mapPool keeps input order and never exceeds the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([5, 1, 3, 2, 4], async (n) => {
    active++;
    peak = Math.max(peak, active);
    await wait(n);
    active--;
    return n * 10;
  }, { concurrency: 2 });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});

test("mapPool drops to a single lane once throttled", async () => {
  let active = 0;
  let peakLate = 0;
  let throttled = false;
  await mapPool(Array.from({ length: 12 }, (_, i) => i), async (i) => {
    if (i === 2) throttled = true;
    active++;
    if (i >= 5) peakLate = Math.max(peakLate, active);
    await wait(5);
    active--;
  }, { concurrency: 3, throttled: () => throttled });
  assert.equal(peakLate, 1);
});

test("mapPool handles an empty list and clamps concurrency to at least one", async () => {
  assert.deepEqual(await mapPool([], async () => 1, { concurrency: 4 }), []);
  assert.deepEqual(await mapPool([1, 2], async (n) => n, { concurrency: 0 }), [1, 2]);
});

/* ----------------------------- factors ----------------------------- */

const rising = Array.from({ length: 300 }, (_, i) => 100 * 1.002 ** i);
const falling = Array.from({ length: 300 }, (_, i) => 100 * 0.998 ** i);
const choppy = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i));

test("rawFactors measures 12-1/6-1 momentum, 52w high, SMA200 trend, volatility and 1-month return", () => {
  const f = rawFactors(rising)!;
  assert.ok(Math.abs(f.mom12_1! - (1.002 ** 231 - 1)) < 1e-9);
  assert.ok(Math.abs(f.mom6_1! - (1.002 ** 105 - 1)) < 1e-9);
  assert.equal(f.high52, 1);
  assert.ok(f.trendPrice! > 0 && f.trendCross! > 0);
  assert.equal(f.aboveSma200, true);
  assert.ok(Math.abs(f.ret1m! - (1.002 ** 21 - 1)) < 1e-9);
  assert.ok(f.vol60! < 1e-9);
});

test("rawFactors needs 147 bars and leaves long-window factors empty on short history", () => {
  assert.equal(rawFactors(rising.slice(0, 146)), null);
  const f = rawFactors(rising.slice(0, 150))!;
  assert.equal(f.mom12_1, null);
  assert.equal(f.trendPrice, null);
  assert.equal(f.aboveSma200, null);
  assert.notEqual(f.mom6_1, null);
});

test("percentileRanks maps lowest to 0 and highest to 100, averages ties, keeps nulls", () => {
  const out = percentileRanks([3, null, 1, 3, 2]);
  assert.deepEqual(out.map((v) => (v == null ? null : Math.round(v))), [83, null, 0, 83, 33]);
  assert.deepEqual(percentileRanks([7]), [50]);
});

test("scoreUniverse ranks a strong uptrend above a downtrend within -100..100", () => {
  const scores = scoreUniverse([
    { symbol: "UP", raw: rawFactors(rising)! },
    { symbol: "DOWN", raw: rawFactors(falling)! },
    { symbol: "CHOP", raw: rawFactors(choppy)! },
  ]);
  assert.ok(scores.get("UP")!.score > scores.get("DOWN")!.score);
  assert.equal(scores.get("UP")!.rank, 100);
  assert.equal(scores.get("DOWN")!.parts.momentum, 0);
  for (const s of scores.values()) assert.ok(s.score >= -100 && s.score <= 100);
});

test("leverageTrigger reports SMA200 position, distance, drawdown and early warning", () => {
  assert.equal(leverageTrigger(rising.slice(0, 199)), null);
  const up = leverageTrigger(rising)!;
  assert.equal(up.aboveSma200, true);
  assert.equal(up.warning, false);
  assert.equal(up.drawdownPct, 0);
  const crashed = [...rising, ...Array.from({ length: 40 }, (_, i) => rising[299] * (1 - 0.006 * (i + 1)))];
  const t = leverageTrigger(crashed)!;
  assert.ok(t.drawdownPct >= 10);
  assert.equal(t.warning, true);
});

/* ----------------------------- hybrid labels and timing gate ----------------------------- */

function ocCandles(rows: Array<[number, number]>): Candle[] {
  return rows.map(([open, close], i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)), open, close,
    high: Math.max(open, close) * 1.005, low: Math.min(open, close) * 0.995, volume: 100000,
  }));
}

test("hybridRecommendation maps factor percentiles to labels", () => {
  const base = { riskOff: false, aboveSma200: true, freshSell: false };
  assert.equal(hybridRecommendation({ ...base, rank: 85 }).recommendation, "קנייה חזקה");
  assert.equal(hybridRecommendation({ ...base, rank: 65 }).recommendation, "קנייה");
  assert.equal(hybridRecommendation({ ...base, rank: 45 }).recommendation, "החזקה");
  assert.equal(hybridRecommendation({ ...base, rank: 10 }).recommendation, "הימנעות / מכירה");
});

test("risk-off allows buys only for the top 10% above SMA200", () => {
  assert.equal(hybridRecommendation({ rank: 95, riskOff: true, aboveSma200: true, freshSell: false }).recommendation, "קנייה חזקה");
  assert.equal(hybridRecommendation({ rank: 95, riskOff: true, aboveSma200: false, freshSell: false }).recommendation, "החזקה");
  assert.equal(hybridRecommendation({ rank: 85, riskOff: true, aboveSma200: true, freshSell: false }).recommendation, "החזקה");
});

test("a fresh sell event turns a buy into wait-for-confirmation without changing the label", () => {
  assert.deepEqual(hybridRecommendation({ rank: 85, riskOff: false, aboveSma200: true, freshSell: true }),
    { recommendation: "קנייה חזקה", waitForConfirmation: true });
  assert.equal(hybridRecommendation({ rank: 10, riskOff: false, aboveSma200: true, freshSell: true }).waitForConfirmation, false);
});

test("analyzeStock exposes fresh technical sell events for the timing gate", () => {
  const calm: Array<[number, number]> = Array.from({ length: 59 }, (_, i) => {
    const c = 100 + (i % 2 ? 0.5 : -0.5);
    return [c, c];
  });
  const red = analyzeStock("X.TA", "X", ocCandles([...calm, [130, 120]]), { symbol: "X.TA" }, EMPTY_NEWS)!;
  assert.equal(red.timing?.freshSell, true);
  assert.ok(red.timing!.reasons.some((r) => r.includes("בולינגר")));
  const up: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => [100 * 1.003 ** (i - 1), 100 * 1.003 ** i]);
  assert.equal(analyzeStock("Y.TA", "Y", ocCandles(up), { symbol: "Y.TA" }, EMPTY_NEWS)!.timing?.freshSell, false);
});

test("buildHorizonInfo defaults the ranking key to the combined score", () => {
  const hz = buildHorizonInfo(40, { score: 20, recommendation: "החזקה" }, null);
  assert.equal(hz.ranking, hz.combined);
});

/* ----------------------------- daily pick ----------------------------- */

function stock(symbol: string, recommendation: Recommendation = "קנייה"): AnalysisResult {
  return {
    symbol, name: symbol, price: 100, score: 50, recommendation,
    signals: [], patterns: [], liquidityNote: "נזילות גבוהה", sequenceStop: null,
    risk: { stop: 90, stopSource: "רצפים", riskPct: 10, target: 120, targetSource: "2R", rr: 2 },
    size: null, levels: { support: null, resistance: null }, relativeStrength: null, divergence: null,
    earningsInDays: null, fundamentals: null, newsSentiment: 0,
    indicators: { rsi: 50, macdHist: null, percentB: null, smaShort: null, smaLong: null, trendUp: true,
      stochK: 50, stochD: null, williamsR: null, atrPct: null, adx: null, obvTrendUp: null, cci: null,
      mfi: null, roc: null, vwap: null, supertrendUp: null, ichimokuPosition: null, chandelier: null },
  } as AnalysisResult;
}

const hz = (ranking: number, extra: Partial<HorizonInfo> = {}): HorizonInfo => ({
  weeklyScore: null, weeklyRec: null, longTerm: null, combined: 50, alignment: "חלקית",
  ranking, engine: "hybrid", ...extra,
});

test("hybrid pick sorts by factor ranking and skips stale, waiting and non-buy candidates", () => {
  const results = [stock("A.TA"), stock("B.TA"), stock("C.TA"), stock("D.TA"), stock("E.TA", "החזקה")];
  const horizons = new Map<string, HorizonInfo>([
    ["A.TA", hz(40)], ["B.TA", hz(90, { stale: true })], ["C.TA", hz(80, { waitForConfirmation: true })],
    ["D.TA", hz(60)], ["E.TA", hz(99)],
  ]);
  const pick = selectDailyPick(results, horizons, null);
  assert.equal(pick.main?.r.symbol, "D.TA");
  assert.deepEqual(pick.alts.map((x) => x.r.symbol), ["A.TA"]);
  assert.ok(pick.rejected.some((x) => x.symbol === "B.TA"));
  assert.ok(pick.rejected.some((x) => x.symbol === "C.TA"));
});

test("red flags block a candidate from the pick and the alternates", () => {
  const flagged: EvidenceGrades = {
    pct: { momentum: 90, revisions: 10, surprise: null, quality: null, value: null, risk: 50, consensus: null, demand: null },
    letters: { momentum: "A", revisions: "F", surprise: null, quality: null, value: null, risk: "C", consensus: null, demand: null },
    redFlags: ["שורט 25% מהמניות הצפות"],
  };
  const results = [stock("RED.TA"), stock("OK.TA")];
  const horizons = new Map<string, HorizonInfo>([["RED.TA", hz(95, { grades: flagged })], ["OK.TA", hz(50)]]);
  const pick = selectDailyPick(results, horizons, null);
  assert.equal(pick.main?.r.symbol, "OK.TA");
  assert.equal(pick.alts.length, 0);
  assert.match(pick.rejected.find((x) => x.symbol === "RED.TA")!.reason, /דגל אדום: שורט 25%/);
});

test("an F in momentum or estimate revisions keeps a stock out of the pick (Seeking Alpha rule)", () => {
  const letters = (momentum: "A" | "F", revisions: "A" | "F" | null): EvidenceGrades => ({
    pct: { momentum: null, revisions: null, surprise: null, quality: null, value: null, risk: null, consensus: null, demand: null },
    letters: { momentum, revisions, surprise: null, quality: null, value: null, risk: null, consensus: null, demand: null },
    redFlags: [],
  });
  const results = [stock("WEAKMOM.TA"), stock("CUTS.TA"), stock("OK.TA")];
  const horizons = new Map<string, HorizonInfo>([
    ["WEAKMOM.TA", hz(95, { grades: letters("F", "A") })],
    ["CUTS.TA", hz(90, { grades: letters("A", "F") })],
    ["OK.TA", hz(50, { grades: letters("A", null) })],
  ]);
  const pick = selectDailyPick(results, horizons, null);
  assert.equal(pick.main?.r.symbol, "OK.TA");
  assert.match(pick.rejected.find((x) => x.symbol === "WEAKMOM.TA")!.reason, /מומנטום F.*Seeking Alpha/);
  assert.match(pick.rejected.find((x) => x.symbol === "CUTS.TA")!.reason, /רוויזיות F/);
});

test("legacy pick still applies the combined threshold without the hybrid engine", () => {
  const results = [stock("LOW.TA"), stock("HIGH.TA")];
  const horizons = new Map<string, HorizonInfo>([
    ["LOW.TA", { weeklyScore: null, weeklyRec: null, longTerm: null, combined: 20, alignment: "אין" }],
    ["HIGH.TA", { weeklyScore: null, weeklyRec: null, longTerm: null, combined: 40, alignment: "חלקית" }],
  ]);
  const pick = selectDailyPick(results, horizons, null);
  assert.equal(pick.main?.r.symbol, "HIGH.TA");
  assert.equal(pick.alts.length, 0);
});

test("macro flags are appended to the regime note", () => {
  const regime: MarketRegime = {
    benchmarkSymbol: "TA35.TA", benchmarkName: 'ת"א 35', price: 1, aboveSma200: true, trendUp: true,
    breadthPct: 50, advancers: 1, decliners: 1, newHighs: 0, newLows: 0, score: 0, label: "ניטרלי", notes: [],
    macroFlags: [{ id: "oil-shock", label: "הלם נפט", detail: "x" }],
  };
  const pick = selectDailyPick([stock("A.TA")], new Map([["A.TA", hz(70)]]), regime);
  assert.match(pick.regimeNote ?? "", /הלם נפט/);
});

/* ----------------------------- walk-forward validation ----------------------------- */

function lcg(seed: number): () => number {
  let x = seed;
  return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function validationRows(dates: number, fwdSign: 1 | -1): ValidationRow[] {
  const rnd = lcg(7);
  const out: ValidationRow[] = [];
  for (let d = 0; d < dates; d++) {
    for (let s = 0; s < 20; s++) {
      const mom = rnd();
      const raw: RawFactors = { mom12_1: mom, mom6_1: mom, high52: rnd(), trendPrice: rnd() - 0.5,
        trendCross: rnd() - 0.5, vol60: rnd(), ret1m: rnd() - 0.5, aboveSma200: true };
      out.push({ symbol: `S${s}`, date: `2026-01-${String(d + 1).padStart(2, "0")}`,
        technical: -mom * 100, raw, freshSell: false, fwd: { 20: fwdSign * mom * 10 + rnd() * 0.1 } });
    }
  }
  return out;
}

test("evaluateEngine adopts a factor variant that beats the technical baseline out of sample", () => {
  const result = evaluateEngine(validationRows(20, 1), [20], new Date("2026-10-19T00:00:00Z"))!;
  assert.ok(result);
  assert.equal(result.adopted, true);
  assert.ok(["V1", "V2", "V3"].includes(result.chosen));
  assert.ok(result.evaluation.find((s) => s.variant === result.chosen)!.horizons["20"].ic! > 0.3);
  assert.ok(result.evaluation.find((s) => s.variant === "V0")!.horizons["20"].ic! < 0);
  assert.equal(result.splitDate, "2026-01-13");
  assert.match(describeEngine(result), /מנוע היברידי פעיל/);
});

test("evaluateEngine rejects factors that lose to the technical baseline", () => {
  const result = evaluateEngine(validationRows(20, -1), [20], new Date("2026-10-19T00:00:00Z"))!;
  assert.equal(result.adopted, false);
  assert.match(result.reason, /לא עקף/);
  assert.match(describeEngine(result), /מוצג בלבד/);
});

test("evaluateEngine needs at least ten dates", () => {
  assert.equal(evaluateEngine(validationRows(9, 1), [20], new Date()), null);
  assert.match(describeEngine(null), /עדיין לא הורצה/);
});

/* ----------------------------- macro, geopolitics, exposure ----------------------------- */

const series = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)), open: c, high: c, low: c, close: c, volume: 0 }));
const ramp = (flat: number, n: number, from: number, to: number, steps: number): number[] => [
  ...Array<number>(n).fill(flat),
  ...Array.from({ length: steps }, (_, i) => from + ((to - from) * (i + 1)) / steps),
];

test("macroFlags detects oil shock, fear, yield pressure and shekel weakness", () => {
  const flags = macroFlags({
    brent: series(ramp(80, 40, 80, 100, 20)),
    vix: series([...Array<number>(30).fill(15), 18, 19, 20, 22, 24, 25]),
    tnx: series(ramp(4.8, 40, 4.8, 5.2, 21)),
    usdils: series(ramp(3.0, 40, 3.0, 3.11, 20)),
  });
  assert.deepEqual(flags.map((f) => f.id), ["oil-shock", "fear", "yield-pressure", "shekel-weakness"]);
});

test("macroFlags stays quiet on calm series and missing data", () => {
  assert.deepEqual(macroFlags({ brent: series(Array<number>(60).fill(80)), vix: series(Array<number>(30).fill(15)),
    tnx: series(Array<number>(60).fill(4)), usdils: series(Array<number>(60).fill(3)) }), []);
  assert.deepEqual(macroFlags({}), []);
});

test("geoHeadlineIntensity counts geopolitical headlines", () => {
  const item = (title: string): NewsItem => ({ source: "x", title, sentiment: 0, ageHours: 1 });
  const geo = geoHeadlineIntensity([item("איראן מאיימת על הורמוז"), item("דוחות טבע"),
    item("Houthi missile hits tanker"), item("הבורסה עלתה")]);
  assert.equal(geo.count, 2);
  assert.equal(geo.total, 4);
  assert.equal(geo.level, "גבוהה");
  assert.equal(geo.percentile, null);
  assert.deepEqual(geo.examples.map((e) => e.source), ["x", "x"]);
});

test("isGeoHeadline matches Hebrew words with prefixes and whole English words only", () => {
  assert.equal(isGeoHeadline("Israeli tanker hits mine in Hormuz"), true);
  assert.equal(isGeoHeadline("מכלית נפגעה ממוקש ימי"), true);
  assert.equal(isGeoHeadline("החשש מהתחדשות המלחמה"), true);
  assert.equal(isGeoHeadline("IRGC seizes vessel"), true);
  assert.equal(isGeoHeadline("Iran nuclear talks stall"), true);
  assert.equal(isGeoHeadline("הלחימה בעזה נמשכת"), true);
  assert.equal(isGeoHeadline("Workers strike at the port"), false);
  assert.equal(isGeoHeadline("Minecraft sales jump"), false);
  assert.equal(isGeoHeadline("Warner Bros earnings"), false);
  assert.equal(isGeoHeadline("Gold mine output rises"), false);
  assert.equal(isGeoHeadline("Trade war fears weigh on chips"), false);
  assert.equal(isGeoHeadline("Nuclear power stocks rally"), false);
  assert.equal(isGeoHeadline("שופרסל בתחרות עזה לשטראוס"), false);
  assert.equal(isGeoHeadline("הדרך לשיקום עוברת בשדה מוקשים"), false);
  assert.equal(isGeoHeadline("האוצר מטיל מס חדש"), false);
  assert.equal(isGeoHeadline("דוחות טבע"), false);
});

test("geoHeadlineIntensity uses provisional share thresholds before history exists", () => {
  const item = (title: string): NewsItem => ({ source: "x", title, sentiment: 0, ageHours: 1 });
  const filler = Array.from({ length: 96 }, (_, i) => item(`bank earnings ${i}`));
  assert.equal(geoHeadlineIntensity([...filler, ...Array.from({ length: 4 }, () => item("Iran war fears"))]).level, "בינונית");
  assert.equal(geoHeadlineIntensity([...filler, item("Iran war fears")]).level, "נמוכה");
});

test("topic feeds supply examples but not the share", () => {
  const item = (title: string, ageHours: number, source = "x"): NewsItem => ({ source, title, sentiment: 0, ageHours });
  const geo = geoHeadlineIntensity([item("bank earnings", 1), item("tech rally", 1)], [],
    [item("Tanker hits mine in Hormuz", 2, "Bing News"), item("Iran warns US", 30, "BBC Middle East")]);
  assert.equal(geo.share, 0);
  assert.equal(geo.count, 0);
  assert.equal(geo.level, "נמוכה");
  assert.deepEqual(geo.examples.map((e) => e.source), ["Bing News", "BBC Middle East"]);
});

test("geoHeadlineIntensity ranks today's share against at least 20 days of history", () => {
  const item = (title: string): NewsItem => ({ source: "x", title, sentiment: 0, ageHours: 1 });
  const news = [item("Iran war fears"), item("Hormuz tanker"), item("bank earnings"), item("tech rally")];
  const short = Array.from({ length: 19 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, share: 0.01, count: 1, total: 100 }));
  assert.equal(geoHeadlineIntensity(news, short).percentile, null);
  const long = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, share: 0.01 + i * 0.001, count: 1, total: 100 }));
  const geo = geoHeadlineIntensity(news, long);
  assert.equal(geo.share, 0.5);
  assert.equal(geo.percentile, 100);
  assert.equal(geo.level, "גבוהה");
  const calm = geoHeadlineIntensity([item("bank earnings"), item("tech rally")], long);
  assert.equal(calm.percentile, 0);
  assert.equal(calm.level, "נמוכה");
});

test("appendGeoHistory replaces the same date and caps the length", () => {
  const base = Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${i + 1}`, share: 0.1, count: 1, total: 10 }));
  const replaced = appendGeoHistory(base, { date: "2026-10-05", share: 0.3, count: 3, total: 10 }, 4);
  assert.equal(replaced.length, 4);
  assert.equal(replaced.at(-1)!.share, 0.3);
  assert.equal(replaced[0].date, "2026-10-02");
});

test("dedupeNews merges headlines that differ only in case and spacing", () => {
  const item = (title: string, source: string): NewsItem => ({ source, title, sentiment: 0, ageHours: 1 });
  const out = dedupeNews([item("Iran  warns US", "a"), item("iran warns us", "b"), item("Other", "a")]);
  assert.deepEqual(out.map((n) => n.source), ["a", "a"]);
});

test("sensitivityMatrix estimates single-factor betas and scenario moves on shared dates", () => {
  const driver = Array.from({ length: 70 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i / 2)) ** i);
  const twice = [100];
  for (let i = 1; i < driver.length; i++) twice.push(twice[i - 1] * (1 + 2 * (driver[i] / driver[i - 1] - 1)));
  const rows = sensitivityMatrix([
    { name: "double", symbol: "D", candles: series(twice) },
    { name: "levered", symbol: "L", candles: series(driver), leverage: 3 },
  ], { ndx: series(driver) });
  assert.ok(Math.abs(rows[0].betaNdx! - 2) < 1e-9);
  assert.ok(Math.abs(rows[0].ndxDown5! - -10) < 1e-6);
  assert.equal(rows[0].betaBrent, null);
  assert.equal(rows[0].brentUp10, null);
  assert.equal(rows[1].leverage, 3);
  assert.ok(Math.abs(rows[1].ndxDown5! - -15) < 1e-6);
});

test("sensitivityMatrix needs at least 21 shared sessions", () => {
  const short = series(Array.from({ length: 15 }, (_, i) => 100 + i));
  assert.equal(sensitivityMatrix([{ name: "s", symbol: "S", candles: short }], { ndx: short })[0].betaNdx, null);
});

test("a dollar-priced holding adds the currency move itself to its shekel sensitivity", () => {
  const usd = Array.from({ length: 70 }, (_, i) => 3 + 0.05 * Math.sin(i / 2));
  const stock = series(Array.from({ length: 70 }, (_, i) => 50 + i));
  const [local, dollar] = sensitivityMatrix([
    { name: "local", symbol: "L", candles: stock },
    { name: "dollar", symbol: "D", candles: stock, usdDenominated: true },
  ], { usdils: series(usd) });
  assert.ok(Math.abs(dollar.usdUp3! - local.usdUp3! - 3) < 1e-9);
});

test("leverageOf reads the fund multiplier from its name", () => {
  assert.equal(leverageOf("קסם ממונפת פי 3 NDX100"), 3);
  assert.equal(leverageOf("Leveraged x3 fund"), 3);
  assert.equal(leverageOf("MTF סל ניקיי 225"), 1);
});

/* ----------------------------- fundamentals and evidence grades ----------------------------- */
const v = (raw: number) => ({ raw });
const quarter = (iso: string) => v(Date.parse(iso) / 1000);
const AS_OF = new Date("2026-10-19T00:00:00Z");

function summary(overrides: Record<string, unknown> = {}) {
  return {
    summaryDetail: { trailingPE: v(14), forwardPE: v(12), dividendYield: v(0.02) },
    defaultKeyStatistics: { priceToBook: v(2), enterpriseToEbitda: v(9), shortPercentOfFloat: v(0.05) },
    financialData: {
      returnOnEquity: v(0.18), returnOnAssets: v(0.06), grossMargins: v(0.4), profitMargins: v(0.12),
      debtToEquity: v(80), freeCashflow: v(1e9), earningsGrowth: v(0.1), revenueGrowth: v(0.05),
    },
    earningsTrend: { trend: [
      { period: "0q", epsTrend: { current: v(1) } },
      { period: "0y", epsTrend: { current: v(3.3), "30daysAgo": v(3.2), "90daysAgo": v(3) },
        epsRevisions: { upLast30days: v(4), downLast30days: v(1) }, earningsEstimate: { numberOfAnalysts: v(17) } },
    ] },
    earningsHistory: { history: [
      { quarter: quarter("2026-06-30"), surprisePercent: v(0.02) },
      { quarter: quarter("2025-09-30"), surprisePercent: v(-0.01) },
      { quarter: quarter("2026-03-31"), surprisePercent: v(9) },
      { quarter: quarter("2025-12-31"), surprisePercent: v(0.05) },
    ] },
    ...overrides,
  };
}

test("parseFundamentals reads quality, value, revisions and surprises", () => {
  const { data, dropped } = parseFundamentals(summary(), "HPQ", AS_OF);
  assert.ok(data);
  assert.equal(data.returnOnAssets, 0.06);
  assert.equal(data.grossMargins, 0.4);
  assert.equal(data.evToEbitda, 9);
  assert.equal(data.shortPercentFloat, 0.05);
  assert.equal(data.epsCurrent, 3.3);
  assert.equal(data.eps30dAgo, 3.2);
  assert.equal(data.eps90dAgo, 3);
  assert.equal(data.revisionsUp30, 4);
  assert.equal(data.revisionsDown30, 1);
  assert.equal(data.epsAnalysts, 17);
  // oldest → newest by quarter, the 900% surprise is out of range
  assert.deepEqual(data.surprises, [-0.01, 0.05, 0.02]);
  assert.equal(dropped, 1);
});

test("parseFundamentals drops impossible values and normalizes TASE agorot multiples", () => {
  const bad = summary({
    summaryDetail: { trailingPE: v(900), forwardPE: v(1250) },
    financialData: { returnOnEquity: v(5), debtToEquity: v(-3), profitMargins: v(0.1) },
  });
  const us = parseFundamentals(bad, "XYZ", AS_OF);
  assert.equal(us.data!.trailingPE, null);
  assert.equal(us.data!.forwardPE, null);
  assert.equal(us.data!.returnOnEquity, null);
  assert.equal(us.data!.debtToEquity, null);
  assert.equal(us.dropped, 5);
  const ta = parseFundamentals(bad, "ABC.TA", AS_OF);
  assert.equal(ta.data!.forwardPE, 12.5);
  assert.equal(ta.data!.trailingPE, 9);
});

test("parseFundamentals ignores earnings surprises older than 15 months", () => {
  const stale = summary({ earningsHistory: { history: [
    { quarter: quarter("2014-09-30"), surprisePercent: v(-0.67) },
    { quarter: quarter("2014-12-31"), surprisePercent: v(-0.84) },
    { quarter: quarter("2026-06-30"), surprisePercent: v(0.03) },
  ] } });
  assert.deepEqual(parseFundamentals(stale, "MGDL.TA", AS_OF).data!.surprises, [0.03]);
});

test("parseFundamentals falls back to the next-year EPS trend and returns null without data", () => {
  const next = summary({ earningsTrend: { trend: [{ period: "+1y", epsTrend: { current: v(5), "30daysAgo": v(5), "90daysAgo": v(4) } }] } });
  assert.equal(parseFundamentals(next, "HPQ").data!.eps90dAgo, 4);
  assert.equal(parseFundamentals({}, "HPQ").data, null);
  assert.equal(parseFundamentals(undefined, "HPQ").data, null);
});

test("parseFundamentals reads analyst consensus, targets, 90-day rating changes, insiders and next-year EPS", () => {
  const day = (iso: string) => Date.parse(iso) / 1000;
  const data = parseFundamentals(summary({
    earningsTrend: { trend: [
      { period: "0y", epsTrend: { current: v(3.3), "30daysAgo": v(3.2), "90daysAgo": v(3) }, earningsEstimate: { numberOfAnalysts: v(17) } },
      { period: "+1y", epsTrend: { current: v(4.4), "30daysAgo": v(4.2), "90daysAgo": v(4) } },
    ] },
    financialData: { targetMeanPrice: v(330), targetHighPrice: v(515), targetLowPrice: v(180), numberOfAnalystOpinions: v(58) },
    recommendationTrend: { trend: [
      { period: "0m", strongBuy: 10, buy: 49, hold: 2, sell: 1, strongSell: 0 },
      { period: "-3m", strongBuy: 8, buy: 40, hold: 10, sell: 2, strongSell: 0 },
    ] },
    upgradeDowngradeHistory: { history: [
      { epochGradeDate: day("2026-10-10"), action: "up", currentPriceTarget: 350, priorPriceTarget: 300 },
      { epochGradeDate: day("2026-09-01"), action: "main", currentPriceTarget: 280, priorPriceTarget: 300 },
      { epochGradeDate: day("2026-08-25"), action: "down", currentPriceTarget: 0, priorPriceTarget: 0 },
      { epochGradeDate: day("2026-05-01"), action: "up", currentPriceTarget: 400, priorPriceTarget: 300 },
    ] },
    netSharePurchaseActivity: { buyInfoCount: v(18), sellInfoCount: v(9) },
    majorHoldersBreakdown: { institutionsPercentHeld: v(0.715) },
  }), "NVDA", AS_OF).data!;
  assert.deepEqual(data.crowd, {
    analysts: 58, buyPct: 59 / 62, buyPct3m: 48 / 60, targetMean: 330, targetHigh: 515, targetLow: 180,
    upgrades90: 1, downgrades90: 1, targetRaises90: 1, targetCuts90: 1, insiderBuys: 18, insiderSells: 9, institutionsPct: 0.715,
  });
  assert.equal(data.epsNextCurrent, 4.4);
  assert.equal(data.epsNext30dAgo, 4.2);
  assert.equal(data.epsNext90dAgo, 4);
  assert.equal(parseFundamentals(summary(), "HPQ", AS_OF).data!.crowd, null);
});

/* ----------------------------- grades ----------------------------- */

const EMPTY: Fundamentals = {
  trailingPE: null, forwardPE: null, priceToBook: null, dividendYield: null, earningsGrowth: null, revenueGrowth: null,
  profitMargins: null, debtToEquity: null, returnOnEquity: null, earningsDate: null, returnOnAssets: null, grossMargins: null,
  freeCashflow: null, evToEbitda: null, shortPercentFloat: null, epsCurrent: null, eps30dAgo: null, eps90dAgo: null,
  revisionsUp30: null, revisionsDown30: null, epsAnalysts: null, surprises: [],
};
const fund = (o: Partial<Fundamentals>): Fundamentals => ({ ...EMPTY, ...o });
const factor = (p: number, lowVol = 50): FactorScore => ({ score: 0, rank: p, aboveSma200: true,
  parts: { momentum: p, high52: p, trend: p, lowVol, reversal: 50 } });

test("letterOf maps percentiles to A–F at 80/60/40/20", () => {
  assert.deepEqual([100, 80, 79.9, 60, 40, 20, 19.9, 0].map(letterOf), ["A", "A", "B", "B", "C", "D", "F", "F"]);
});

test("gradeUniverse ranks each grade within the universe and needs two inputs", () => {
  const grades = gradeUniverse([
    { symbol: "GOOD", financial: false, factor: factor(90, 90),
      f: fund({ returnOnEquity: 0.3, returnOnAssets: 0.1, forwardPE: 10, priceToBook: 2, epsAnalysts: 5, epsCurrent: 1.2, eps30dAgo: 1.1, eps90dAgo: 1, surprises: [0.05, 0.1] }) },
    { symbol: "MID", financial: false, factor: factor(50),
      f: fund({ returnOnEquity: 0.1, returnOnAssets: 0.05, forwardPE: 20, priceToBook: 3, epsAnalysts: 5, epsCurrent: 1, eps30dAgo: 1, eps90dAgo: 1, surprises: [0, 0] }) },
    { symbol: "BAD", financial: false, factor: factor(10, 10),
      f: fund({ returnOnEquity: -0.1, returnOnAssets: -0.02, forwardPE: 40, priceToBook: 6, epsAnalysts: 5, epsCurrent: 0.8, eps30dAgo: 0.9, eps90dAgo: 1, surprises: [-0.1, -0.2] }) },
    { symbol: "THIN", financial: false, f: fund({ returnOnEquity: 0.2, surprises: [0.3], epsAnalysts: 1, epsCurrent: 2, eps30dAgo: 1, eps90dAgo: 1 }) },
  ]);
  const good = grades.get("GOOD")!;
  assert.deepEqual([good.letters.momentum, good.letters.quality, good.letters.value, good.letters.revisions, good.letters.surprise, good.letters.risk],
    ["A", "A", "A", "A", "A", "A"]);
  assert.equal(grades.get("BAD")!.letters.quality, "F");
  const thin = grades.get("THIN")!;
  assert.equal(thin.letters.quality, null);
  assert.equal(thin.letters.surprise, null);
  assert.equal(thin.letters.momentum, null);
  assert.equal(thin.letters.revisions, null);
});

test("financials skip leverage and EBITDA yield and ignore a zero gross margin", () => {
  const grades = gradeUniverse([
    { symbol: "BANK", financial: true, f: fund({ returnOnEquity: 0.15, grossMargins: 0, debtToEquity: 900, evToEbitda: 3 }) },
    { symbol: "IND", financial: false, f: fund({ returnOnEquity: 0.1, grossMargins: 0.3 }) },
  ]);
  assert.equal(grades.get("BANK")!.letters.quality, null);
  assert.equal(grades.get("BANK")!.letters.value, null);
  assert.equal(grades.get("IND")!.letters.quality, "C");
});

test("redFlags catch estimate cuts, repeated misses, leverage with cash burn and heavy short interest", () => {
  assert.match(redFlags(fund({ epsAnalysts: 3, epsCurrent: 0.85, eps90dAgo: 1, revisionsUp30: 1, revisionsDown30: 5 }), false)[0], /תחזית הרווח ירדה 15%/);
  assert.equal(redFlags(fund({ epsAnalysts: 1, epsCurrent: 0.85, eps90dAgo: 1, revisionsUp30: 1, revisionsDown30: 5 }), false).length, 0);
  assert.equal(redFlags(fund({ epsAnalysts: 3, epsCurrent: 0.85, eps90dAgo: 1, revisionsUp30: 5, revisionsDown30: 1 }), false).length, 0);
  assert.match(redFlags(fund({ surprises: [0.1, -0.06, -0.08] }), false)[0], /שתי הפתעות שליליות/);
  assert.match(redFlags(fund({ debtToEquity: 350, freeCashflow: -1 }), false)[0], /מינוף/);
  assert.equal(redFlags(fund({ debtToEquity: 350, freeCashflow: -1 }), true).length, 0);
  assert.match(redFlags(fund({ shortPercentFloat: 0.25 }), false)[0], /שורט 25%/);
  assert.deepEqual(redFlags(null, false), []);
});

test("gradeChips and gradeWhy explain the card", () => {
  const g = gradeUniverse([
    { symbol: "A", financial: false, factor: factor(90, 10), f: fund({ returnOnEquity: 0.3, returnOnAssets: 0.1, shortPercentFloat: 0.3 }) },
    { symbol: "B", financial: false, factor: factor(10, 90), f: fund({ returnOnEquity: 0.1, returnOnAssets: 0.01 }) },
  ]).get("A")!;
  assert.equal(gradeChips(g), "מומנטום A · רוויזיות — · הפתעות — · איכות A · שווי — · סיכון F · קונצנזוס — · ביקוש —");
  assert.match(gradeWhy(g), /חזק: מומנטום \(A\), איכות \(A\) · חלש: סיכון \(F\) · דגלים: שורט 30%/);
});

const crowd = (o: Partial<CrowdData>): CrowdData => ({ analysts: 10, buyPct: 0.5, buyPct3m: 0.5, targetMean: 100, targetHigh: 120, targetLow: 80,
  upgrades90: 0, downgrades90: 0, targetRaises90: 0, targetCuts90: 0, insiderBuys: null, insiderSells: null, institutionsPct: null, ...o });

test("consensus grade ranks analyst conviction, its 3-month change, target upside and target revisions; needs 3 analysts", () => {
  const g = gradeUniverse([
    { symbol: "LOVED", financial: false, price: 100, f: fund({ crowd: crowd({ buyPct: 0.95, buyPct3m: 0.8, targetMean: 150, targetRaises90: 5, upgrades90: 2 }) }) },
    { symbol: "MID", financial: false, price: 100, f: fund({ crowd: crowd({}) }) },
    { symbol: "HATED", financial: false, price: 100, f: fund({ crowd: crowd({ buyPct: 0.1, buyPct3m: 0.4, targetMean: 80, targetCuts90: 4, downgrades90: 2 }) }) },
    { symbol: "THIN", financial: false, price: 100, f: fund({ crowd: crowd({ analysts: 2, buyPct: 1, targetMean: 300 }) }) },
  ]);
  assert.equal(g.get("LOVED")!.letters.consensus, "A");
  assert.equal(g.get("HATED")!.letters.consensus, "F");
  assert.equal(g.get("THIN")!.letters.consensus, null);
});

test("demand grade ranks up-volume vs down-volume accumulation", () => {
  const g = gradeUniverse([
    { symbol: "ACC", financial: false, accumulation: 2.4, f: null },
    { symbol: "FLAT", financial: false, accumulation: 1, f: null },
    { symbol: "DIST", financial: false, accumulation: 0.4, f: null },
  ]);
  assert.deepEqual(["ACC", "FLAT", "DIST"].map((s) => g.get(s)!.letters.demand), ["A", "C", "F"]);
});

test("quality and value are ranked within the sector when it has at least 5 graded names", () => {
  const bank = (s: string, roe: number) => ({ symbol: s, financial: true, sector: "בנקים", f: fund({ returnOnEquity: roe, returnOnAssets: roe / 10, profitMargins: roe }) });
  const tech = (s: string, roe: number) => ({ symbol: s, financial: false, sector: "טק", f: fund({ returnOnEquity: roe, returnOnAssets: roe / 2, profitMargins: roe }) });
  const g = gradeUniverse([
    bank("B1", 0.10), bank("B2", 0.11), bank("B3", 0.12), bank("B4", 0.13), bank("B5", 0.14),
    tech("T1", 0.4), tech("T2", 0.5),
  ]);
  // the best bank is A among banks although every tech name has a higher ROE
  assert.equal(g.get("B5")!.letters.quality, "A");
  assert.equal(g.get("B1")!.letters.quality, "F");
  // a sector with fewer than 5 names falls back to the whole universe
  assert.equal(g.get("T2")!.letters.quality, "A");
});

test("revisions include the next fiscal year (Zacks: current and next year)", () => {
  const base = { epsAnalysts: 5, epsCurrent: 1, eps30dAgo: 1, eps90dAgo: 1 };
  const g = gradeUniverse([
    { symbol: "NEXT_UP", financial: false, f: fund({ ...base, epsNextCurrent: 1.3, epsNext30dAgo: 1.1, epsNext90dAgo: 1 }) },
    { symbol: "NEXT_DOWN", financial: false, f: fund({ ...base, epsNextCurrent: 0.8, epsNext30dAgo: 0.9, epsNext90dAgo: 1 }) },
  ]);
  assert.equal(g.get("NEXT_UP")!.letters.revisions, "A");
  assert.equal(g.get("NEXT_DOWN")!.letters.revisions, "F");
});

test("starRating widens the margin of safety with target dispersion and needs 3 analysts", () => {
  // low dispersion (0.2): 5 stars at price <= 0.80 x fair value
  assert.equal(starRating(79, crowd({ targetMean: 100, targetHigh: 110, targetLow: 90 }))!.stars, 5);
  assert.equal(starRating(100, crowd({ targetMean: 100, targetHigh: 110, targetLow: 90 }))!.stars, 3);
  assert.equal(starRating(130, crowd({ targetMean: 100, targetHigh: 110, targetLow: 90 }))!.stars, 1);
  // high dispersion (1.0): 79% of fair value is only 4 stars
  const wide = starRating(79, crowd({ targetMean: 100, targetHigh: 150, targetLow: 50 }))!;
  assert.equal(wide.stars, 4);
  assert.equal(wide.uncertainty, "גבוהה");
  assert.equal(starRating(79, crowd({ analysts: 2 })), null);
  assert.equal(starRating(79, null), null);
});

const closesOf = (xs: number[]): Candle[] => xs.map((c, i) => ({ date: new Date(Date.UTC(2025, 0, 1 + i)), open: c, high: c, low: c, close: c, volume: 1000 }));

test("rsRatings weights the latest quarter double and maps to 1..99", () => {
  const flatThenUp = Array.from({ length: 260 }, (_, i) => (i < 197 ? 100 : 100 + (i - 196) * 0.5));
  const upThenFlat = Array.from({ length: 260 }, (_, i) => (i < 63 ? 100 + i * 0.5 : 131.5));
  const down = Array.from({ length: 260 }, (_, i) => 100 - i * 0.1);
  const r = rsRatings([{ symbol: "RECENT", closes: flatThenUp }, { symbol: "OLD", closes: upThenFlat }, { symbol: "DOWN", closes: down }, { symbol: "SHORT", closes: [1, 2, 3] }]);
  assert.equal(r.get("RECENT"), 99);
  assert.equal(r.get("DOWN"), 1);
  assert.ok(r.get("OLD")! > 1 && r.get("OLD")! < 99);
  assert.equal(r.has("SHORT"), false);
});

test("accumulationRatio compares up-day and down-day volume over 65 sessions", () => {
  const candles = closesOf(Array.from({ length: 70 }, (_, i) => 100 + (i % 2 ? 1 : 0)));
  candles.forEach((c, i) => { c.volume = i % 2 ? 300 : 100; });
  // 65 sessions: 33 up days x 300 vs 32 down days x 100
  assert.equal(accumulationRatio(candles), (33 * 300) / (32 * 100));
  assert.equal(accumulationRatio(candles.slice(0, 30)), null);
});

test("topUpZone flags stretched prices, good pullbacks and earnings proximity", () => {
  const rising = Array.from({ length: 260 }, (_, i) => 100 + i);
  const stretched = topUpZone({ closes: [...rising, 420], rsi: 75, stars: 3, earningsInDays: null, longTerm: "חיובי" });
  assert.equal(stretched.zone, "stretched");
  const pullback = [...rising, ...Array.from({ length: 30 }, (_, i) => 359 - i * 2)];
  const good = topUpZone({ closes: pullback, rsi: 40, stars: 3, earningsInDays: 6, longTerm: "חיובי" });
  assert.equal(good.zone, "good");
  assert.match(good.reasons.join(" "), /דוחות בעוד 6 ימים/);
  assert.equal(topUpZone({ closes: rising, rsi: 55, stars: 5, earningsInDays: null, longTerm: "חיובי" }).zone, "good");
  assert.equal(topUpZone({ closes: rising, rsi: 55, stars: null, earningsInDays: null, longTerm: "חיובי" }).zone, "fair");
});

test("pivotExtension warns only after a fresh breakout more than 5% above the base high", () => {
  const base = Array.from({ length: 40 }, () => 100);
  assert.equal(pivotExtension(closesOf([...base, 103, 108]))!.pct > 5, true);
  assert.equal(pivotExtension(closesOf([...base, 101, 103])), null);
  assert.equal(pivotExtension(closesOf([...base])), null);
});

function dailyCandles(rate: number, days: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i));
    price *= 1 + rate;
    out.push({ date, open: price, high: price, low: price, close: price, volume: 0 });
  }
  return out;
}

test("evaluateGradeHistory measures forward IC and requires 40 dates", () => {
  const candles = new Map<string, Candle[]>();
  const history: GradeHistory = {};
  for (let k = 0; k < 12; k++) candles.set(`S${k}`, dailyCandles(0.001 * k, 140));
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2026, 0, 2 + d)).toISOString().slice(0, 10);
    history[date] = Object.fromEntries([...candles.keys()].map((s, k) => [s, { momentum: k * 9, value: 100 - k * 9 }]));
  }
  const v = evaluateGradeHistory(history, candles);
  assert.ok(v.dates >= 40);
  assert.ok(v.grades.momentum.ic! > 0.99);
  assert.equal(v.grades.momentum.passed, true);
  assert.ok(v.grades.value.ic! < -0.99);
  assert.equal(v.grades.value.passed, false);
  assert.equal(v.grades.quality.ic, null);
  const short = evaluateGradeHistory(Object.fromEntries(Object.entries(history).slice(0, 10)), candles);
  assert.equal(short.grades.momentum.passed, false);
  assert.match(describeGradeValidation(short, []), /בבדיקה קדימה: 10\/40 תאריכים/);
  assert.match(describeGradeValidation(v, ["momentum"]), /מומנטום IC 1\.00.*עבר.*בדירוג: מומנטום/);
  assert.match(describeGradeValidation(null, []), /טרם נאספו/);
});

test("appendGradeHistory keeps the newest dates", () => {
  const h: GradeHistory = { "2026-10-01": {}, "2026-10-02": {}, "2026-10-03": {} };
  const out = appendGradeHistory(h, "2026-10-04", { X: { momentum: 50 } }, 3);
  assert.deepEqual(Object.keys(out), ["2026-10-02", "2026-10-03", "2026-10-04"]);
});

/* ----------------------- followed creator + trend-change setups ----------------------- */

test("underlyingStatus flags a close below the rule level and reports the distance otherwise", () => {
  const rule = { taseNumber: "1", symbol: "BZ=F", name: "ברנט", below: 100, action: "למכור חצי" };
  const hit = underlyingStatus(rule, bars([105, 99]))!;
  assert.equal(hit.hit, true);
  assert.match(underlyingText(hit), /🚨 ברנט 99\.00 מתחת ל-100 — הכלל: למכור חצי/);
  const above = underlyingStatus(rule, bars([105, 110]))!;
  assert.equal(above.hit, false);
  assert.ok(Math.abs(above.distancePct - 10) < 1e-9);
  assert.match(underlyingText(above), /עוד 10\.0%/);
  assert.equal(underlyingStatus(rule, []), null);
});

const BOILER = "אני מיכה ⸻ 📌 על הסרטון הזה:";
const FEED = `<?xml version="1.0"?><feed>
<entry><yt:videoId>U4EIznieGvg</yt:videoId><title>⚠️ 5 מניות &amp; &quot;דוחות&quot;</title><published>2026-11-01T17:00:00+00:00</published>
<media:group><media:description>${BOILER} פלנטיר, AMD ו-(NET) זזות. 0:00 - שבוע דרמטי 1:02 - לוח הדיווחים ⸻ 🛡️ שימו לב</media:description></media:group></entry>
<entry><yt:videoId>3BwjABQy5A4</yt:videoId><title>מבזק לייב פתיחה</title><published>2026-10-30T13:00:00+00:00</published>
<media:group><media:description>${BOILER} [כאן יופיע תיאור הפרק + חותמות זמן] ⸻ סוף</media:description></media:group></entry>
<entry><yt:videoId>bad id!</yt:videoId><title>x</title></entry>
</feed>`;

test("parseYoutubeFeed keeps valid entries, decodes entities and splits blurb from chapters", () => {
  const videos = parseYoutubeFeed(FEED, "מיכה סטוקס");
  assert.equal(videos.length, 2);
  assert.equal(videos[0].title, '⚠️ 5 מניות & "דוחות"');
  assert.equal(videos[0].url, "https://www.youtube.com/watch?v=U4EIznieGvg");
  assert.equal(videos[0].blurb, "פלנטיר, AMD ו-(NET) זזות.");
  assert.deepEqual(videos[0].chapters, ["0:00 - שבוע דרמטי", "1:02 - לוח הדיווחים"]);
  assert.equal(videos[1].blurb, "");
  assert.deepEqual(splitDescription("no marker here"), { blurb: "", chapters: [] });
});

test("markNewVideos flags unseen ids and same-day first sightings", () => {
  const videos = parseYoutubeFeed(FEED, "c");
  const first = markNewVideos(videos, { "3BwjABQy5A4": "2026-10-30T15:00:00.000Z" }, "2026-11-02T07:00:00.000Z");
  assert.deepEqual(first.videos.map((v) => v.isNew), [true, false]);
  const rerun = markNewVideos(videos, first.seen, "2026-11-02T11:00:00.000Z");
  assert.deepEqual(rerun.videos.map((v) => v.isNew), [true, false]);
  const tomorrow = markNewVideos(videos, first.seen, "2026-11-03T07:00:00.000Z");
  assert.deepEqual(tomorrow.videos.map((v) => v.isNew), [false, false]);
});

test("containsHebrewWord allows only the ו prefix and whole words", () => {
  assert.ok(containsHebrewWord("וגוגל נפלה", "גוגל"));
  assert.ok(!containsHebrewWord("מבזק לייב פתיחה", "בזק"));
  assert.ok(!containsHebrewWord("אל עליות בשוק", "אל על"));
  assert.ok(containsHebrewWord("מניית אל על עלתה", "אל על"));
  assert.ok(!containsHebrewWord("CHPT", "HP"));
});

test("findMentions maps tickers, aliases and watchlist names, and skips non-tickers", () => {
  const video: CreatorVideo = { channel: "c", id: "abcdefgh", title: "AI ו-ATR: אנבידיה ואל על", published: "", url: "", blurb: "אדובי (ADBE) וגוגל", chapters: ["0:00 - AMD"] };
  const mentions = findMentions([video], [{ symbol: "NVDA", name: "אנבידיה" }, { symbol: "ELAL.TA", name: "אל על" }], new Set(["NVDA"]), { "אנבידיה": "NVDA", "גוגל": "GOOGL", "אדובי": "ADBE" });
  const symbols = mentions.map((m) => m.symbol);
  assert.deepEqual(symbols.slice(0, 2), ["NVDA", "ELAL.TA"]);
  assert.ok(symbols.includes("ADBE") && symbols.includes("GOOGL") && symbols.includes("AMD"));
  assert.ok(!symbols.includes("AI") && !symbols.includes("ATR"));
  assert.equal(mentions[0].held, true);
  assert.equal(mentions.find((m) => m.symbol === "ADBE")?.tracked, false);
});

/** Linear close path through [index, close] points; highs/lows ±1%. */
function path(points: [number, number][]): Candle[] {
  const out: Candle[] = [];
  for (let k = 1; k < points.length; k++) {
    const [i0, c0] = points[k - 1];
    const [i1, c1] = points[k];
    for (let i = k === 1 ? i0 : i0 + 1; i <= i1; i++) {
      const c = c0 + ((c1 - c0) * (i - i0)) / (i1 - i0);
      out.push({ date: new Date(Date.UTC(2026, 0, 1 + i)), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 });
    }
  }
  return out;
}

const HEAD: [number, number][] = [[0, 80], [20, 100], [50, 70], [100, 97], [120, 80]];

test("trendChangeSetup classifies base, line-break, breakout and no-structure", () => {
  assert.equal(trendChangeSetup(path([[0, 50], [130, 100]]))?.status, "none");
  const base = trendChangeSetup(path([...HEAD, [130, 85]]))!;
  assert.equal(base.status, "base");
  assert.ok(base.line! > 85 && base.trigger! > base.line!);
  assert.ok(Math.abs(base.higherLow! - 79.2) < 1e-9);
  assert.ok(base.stop! < base.higherLow! && base.target === 101);
  const deep = trendChangeSetup(path([[0, 80], [20, 200], [50, 70], [100, 97], [120, 80], [130, 99]]))!;
  assert.ok(Math.abs(deep.target! - (2 * 97.97 - 69.3)) < 1e-9, "measured move below the old high");
  assert.equal(trendChangeSetup(path([...HEAD, [130, 97.5]]))?.status, "line-break");
  const breakout = trendChangeSetup(path([...HEAD, [130, 99]]))!;
  assert.equal(breakout.status, "breakout");
  assert.ok(breakout.extendedPct! > 0 && breakout.extendedPct! < 2);
  assert.equal(base.waitThreeDays, false);
});

test("trendChangeSetup applies the three-day rule after a ≥2×ATR drop", () => {
  const candles = path([...HEAD, [130, 85]]);
  candles.push({ date: new Date(Date.UTC(2026, 6, 1)), open: 85, high: 85, low: 79.5, close: 80, volume: 3000 });
  const setup = trendChangeSetup(candles)!;
  assert.equal(setup.waitThreeDays, true);
  assert.match(methodVerdict({ setup, earningsInDays: null }), /3 הימים/);
  assert.match(methodVerdict({ setup: trendChangeSetup(path([...HEAD, [130, 99]]))!, earningsInDays: 3 }), /דוח בעוד 3/);
});

test("buildCreatorView ranks setups, keeps mentions without data as names, and the section escapes feed text", () => {
  const candles = new Map<string, Candle[]>([
    ["AAA.TA", path([...HEAD, [130, 85]])],
    ["BBB.TA", path([...HEAD, [130, 99]])],
    ["CCC.TA", path([[0, 50], [130, 100]])],
  ]);
  const view = buildCreatorView(["מיכה סטוקס"], [], [
    { symbol: "BBB.TA", name: "בבב", tracked: true, held: true, videoIds: ["v1"] },
    { symbol: "ZZZ", name: "ZZZ", tracked: false, held: false, videoIds: ["v1"] },
  ], {
    candles,
    names: new Map([["AAA.TA", "אאא"], ["BBB.TA", "בבב"], ["CCC.TA", "גגג"]]),
    held: new Set(["BBB.TA"]),
    results: new Map(),
    combined: new Map([["BBB.TA", 40]]),
  });
  assert.deepEqual(view.setups.map((r) => r.symbol), ["BBB.TA", "AAA.TA"]);
  assert.equal(view.mentions[0].held, true);
  assert.deepEqual(view.otherMentions, ["ZZZ"]);
  const html = renderCreatorSection({ ...view, videos: [{ channel: "c", id: "abcdefgh", title: "<img src=x onerror=alert(1)>", published: "2026-11-01T10:00:00Z", url: "javascript:alert(1)", blurb: "", chapters: [], isNew: true }] });
  assert.ok(!html.includes("<img") && html.includes("&lt;img"));
  assert.ok(!html.includes("javascript:"));
});

/* ----------------------- his rules as a gate on recommendations ----------------------- */

const NEW_LAYOUT = `🎓 מיכה סטוקס – חינוך פיננסי

אני מיכה, ומאז 2021 אני מפרסם כל יום סרטון.

⸻
🏆 קהילת PLUS + קורס: https://example.com
🎟️ קוד קופון: 10OFF

⸻
📈 מה תמצאו בערוץ החינמי:
- סרטון יומי

⸻
אנבידיה איבדה 30% בחמישה שבועות.
בסרטון: 5 לקחים – שבירת ממוצע 150.

00:00 - אנבידיה מ-239 ל-160
02:34 - השבוע של אנבידיה בקצרה
⸻
🛡️ שימו לב – הונאות מתחזות
⸻
⚠️ דיסקליימר #שוקההון`;

test("splitDescription reads the layout without the per-video marker and skips channel boilerplate", () => {
  const { blurb, chapters } = splitDescription(NEW_LAYOUT);
  assert.equal(blurb, "אנבידיה איבדה 30% בחמישה שבועות. בסרטון: 5 לקחים – שבירת ממוצע 150.");
  assert.deepEqual(chapters, ["00:00 - אנבידיה מ-239 ל-160", "02:34 - השבוע של אנבידיה בקצרה"]);
  assert.deepEqual(splitDescription("🎓 intro ⸻ 🏆 course ⸻ ⚠️ disclaimer"), { blurb: "", chapters: [] });
});

test("the channel-page fallback lists videos with a date from the relative label, and the watch page adds the description", () => {
  const lockup = (id: string, title: string, age: string, type = "LOCKUP_CONTENT_TYPE_VIDEO") => ({ richItemRenderer: { content: { lockupViewModel: {
    contentId: id, contentType: type,
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [
      { text: { content: "5.4K" }, accessibilityLabel: "5.4 thousand views" }, { text: { content: "x" }, accessibilityLabel: age }] }] } } } },
  } } } });
  const data = { contents: [lockup("EMsF6Zna0hU", "דוח <ראשון>", "3 hours ago"), lockup("P1s59W5W_ko", "סייבר", "Streamed 2 days ago"),
    lockup("EMsF6Zna0hU", "כפול", "1 day ago"), lockup("PLxxxxxxxxx", "פלייליסט", "1 day ago", "LOCKUP_CONTENT_TYPE_PLAYLIST"),
    { videoRenderer: { videoId: "Ey1URdF6YUg", title: { runs: [{ text: "ישן" }] }, publishedTimeText: { simpleText: "2 weeks ago" } } }] };
  const now = Date.UTC(2026, 10, 16, 6);
  const listed = parseChannelPage(`<script id="yt-initial-data" type="application/json" nonce="n">${JSON.stringify(data)}</script>`, "מיכה סטוקס", now);
  assert.deepEqual(listed.map((v) => v.id), ["EMsF6Zna0hU", "P1s59W5W_ko", "Ey1URdF6YUg"]);
  assert.deepEqual(listed.map((v) => v.published.slice(0, 13)), ["2026-11-16T03", "2026-11-14T06", "2026-11-02T06"]);
  assert.ok(listed.every((v) => v.source === "channel" && v.blurb === ""));
  assert.deepEqual(parseChannelPage("<html>consent</html>", "c", now), []);

  const watch = `var x = {"videoDetails":{"videoId":"EMsF6Zna0hU","title":"דוח \\"ראשון\\" \\u0026 הכנה","lengthSeconds":"700","shortDescription":${JSON.stringify(NEW_LAYOUT)},"isCrawlable":true},"microformat":{"publishDate":"2026-11-15T19:30:20-08:00"}}`;
  const video = parseWatchPage(watch, "EMsF6Zna0hU", "מיכה סטוקס")!;
  assert.equal(video.title, 'דוח "ראשון" & הכנה');
  assert.equal(video.published, "2026-11-15T19:30:20-08:00");
  assert.equal(video.chapters.length, 2);
  assert.equal(parseWatchPage(watch, "P1s59W5W_ko", "c"), null, "a page for another video is not accepted");
  assert.equal(parseWatchPage("<html>Our systems have detected unusual traffic</html>", "EMsF6Zna0hU", "c"), null);

  const cache = rememberVideos({}, [{ ...video, isNew: true }, listed[1]]);
  assert.deepEqual(Object.keys(cache), ["EMsF6Zna0hU"], "title-only entries are not cached, so their description is fetched next time");
  assert.equal("isNew" in cache.EMsF6Zna0hU, false);
  assert.equal(Object.keys(rememberVideos(cache, [{ ...video, id: "newerVideo1", published: "2026-11-16T10:00:00Z" }], 1))[0], "newerVideo1");
});

test("methodCheck blocks a buy below SMA150 and inside the earnings window, and lets a trend-change breakout through", () => {
  const rising = methodCheck(path([[0, 50], [200, 100]]), null)!;
  assert.ok(rising.sma150Pct! > 0);
  assert.equal(rising.sessionsBelow, 0);
  assert.deepEqual(rising.blocks, []);
  assert.match(methodPassLine(rising), /מעל ממוצע 150/);

  const falling = methodCheck(path([[0, 100], [200, 70]]), 20)!;
  assert.ok(falling.sma150Pct! < 0 && falling.sessionsBelow > 40);
  assert.equal(falling.blocks.length, 1);
  assert.match(falling.blocks[0], /מתחת לממוצע 150/);
  assert.match(holdingVerdict(falling, "own"), /נורת אזהרה: לא מחזקים/);
  assert.match(holdingVerdict(falling, "index"), /^מדד הייחוס מתחת לממוצע 150/);

  assert.match(methodCheck(path([[0, 50], [200, 100]]), 7)!.blocks[0], /דוח בעוד 7 ימים/);
  assert.deepEqual(methodCheck(path([[0, 50], [200, 100]]), 8)!.blocks, []);
  assert.match(holdingVerdict(methodCheck(path([[0, 50], [200, 100]]), 1)!, "own"), /לא מוסיפים לפני הדוח/);

  // A long decline, then his setup: higher low and a close above the last lower high — still under the average
  const breakout = methodCheck(path([[0, 300], [100, 150], [130, 70], [180, 97], [200, 80], [210, 99]]), null)!;
  assert.equal(breakout.setup, "breakout");
  assert.ok(breakout.sma150Pct! < 0);
  assert.deepEqual(breakout.blocks, []);

  assert.equal(methodCheck(path([[0, 50], [100, 60]]), null)!.sma150Pct, null, "fewer than 150 bars");
  assert.equal(methodCheck([], null), null);
});

test("a candidate blocked by his rules is rejected with the reason, and rejections are listed by rank", () => {
  const blocked = methodCheck(path([[0, 100], [200, 70]]), null)!;
  const clear = methodCheck(path([[0, 50], [200, 100]]), null)!;
  const results = [stock("LOW.TA"), stock("BELOW.TA"), stock("OK.TA")];
  const horizons = new Map<string, HorizonInfo>([
    ["LOW.TA", hz(10, { stale: true })], ["BELOW.TA", hz(95, { method: blocked })], ["OK.TA", hz(50, { method: clear })],
  ]);
  const pick = selectDailyPick(results, horizons, null);
  assert.equal(pick.main?.r.symbol, "OK.TA");
  assert.deepEqual(pick.rejected.map((x) => x.symbol), ["BELOW.TA", "LOW.TA"]);
  assert.match(pick.rejected[0].reason, /^כללי מיכה סטוקס: מתחת לממוצע 150/);
});

test("the creator section lists the rules and reads the portfolio by them, also without videos", () => {
  const view = buildCreatorView(["מיכה סטוקס"], [], [], {
    candles: new Map(), names: new Map(), held: new Set(), results: new Map(), combined: new Map(),
    portfolio: [
      { name: "אנבידיה", id: "NVDA", basis: "own", candles: path([[0, 100], [200, 70]]), earningsInDays: 1, sector: "טק" },
      { name: "קרן <b>", id: "1146976", basis: "index", basisName: "^NDX", candles: path([[0, 50], [200, 100]]), earningsInDays: null, sector: "טק" },
      { name: "בלי נתונים", id: "1150531", basis: "index", basisName: "^N225", candles: undefined, earningsInDays: null, sector: "יפן" },
    ],
  });
  assert.deepEqual(view.holdings.map((h) => h.id), ["NVDA", "1146976"]);
  assert.deepEqual(view.holdingsWithoutData, ["בלי נתונים"]);
  assert.match(view.holdings[0].verdict, /מתחת לממוצע 150.*דוח בעוד 1 ימים/);
  assert.match(view.concentration ?? "", /2 מתוך 3 החזקות בסקטור טק/);
  assert.equal(sectorConcentration(["א", "ב", "ג"]), null);
  const html = renderCreatorSection(view);
  assert.ok(html.includes("הכללים שמופעלים על ההמלצות") && html.includes("מדד ייחוס ^NDX"));
  assert.ok(html.includes("קרן &lt;b&gt;") && !html.includes("קרן <b>"));
});

/* ----------------------- funds through their index + per-market lists ----------------------- */

const check = (sma150Pct: number | null, blocks: string[] = []): MethodCheck => ({ sma150: 100, sma150Pct, sessionsBelow: 0, waitThreeDays: false, earningsInDays: null, setup: "none", blocks });
const trig = (aboveSma200: boolean, extra: Partial<LeverageTrigger> = {}): LeverageTrigger => ({ aboveSma200, distancePct: aboveSma200 ? 3 : -3.9, sma50BelowSma200: false, drawdownPct: 4, warning: false, ...extra });

test("fundDecision: leverage below SMA200 or a weak index below SMA150 reduces; a clean buy adds; risk-off and warnings hold", () => {
  const base = { recommendation: "קנייה" as Recommendation, combined: 30, method: check(2), trigger: trig(true), leverage: 3, riskOff: false };
  assert.equal(fundDecision(base).action, "קנייה / חיזוק");
  const below200 = fundDecision({ ...base, trigger: trig(false) });
  assert.equal(below200.action, "צמצום / מכירה");
  assert.match(below200.reasons[0], /-3\.9% מממוצע 200.*×3/);
  assert.equal(fundDecision({ ...base, trigger: trig(false), leverage: 1 }).action, "קנייה / חיזוק", "the SMA200 rule is for leveraged funds only");
  const weak = fundDecision({ ...base, recommendation: "הימנעות / מכירה", combined: -45, method: check(-7.6), leverage: 1 });
  assert.equal(weak.action, "צמצום / מכירה");
  assert.match(weak.reasons[0], /ממוצע 150 \(-7\.6%\).*משולב -45/);
  assert.equal(fundDecision({ ...base, combined: -45, method: check(5) }).action, "החזקה", "weak but above SMA150 is not a sell");
  const riskOff = fundDecision({ ...base, riskOff: true });
  assert.equal(riskOff.action, "החזקה");
  assert.ok(riskOff.reasons.some((r) => r.includes("ריסק-אוף")));
  assert.match(fundDecision({ ...base, trigger: trig(true, { warning: true, sma50BelowSma200: true }) }).reasons.join(" "), /ממוצע 50 מתחת/);
  assert.match(fundDecision({ ...base, method: check(-1, ["מתחת לממוצע 150"]) }).reasons.join(" "), /מתחת לממוצע 150/);
});

test("fund levels multiply the index risk by the leverage, and the full engine runs on the index candles", () => {
  const levels = fundLevels(1000, 3, stock("^NDX"))!;
  assert.ok(Math.abs(levels.riskPct - 30) < 1e-9 && Math.abs(levels.stop - 700) < 1e-9);
  assert.ok(Math.abs(levels.rewardPct - 60) < 1e-9 && Math.abs(levels.target - 1600) < 1e-9);
  assert.equal(fundLevels(null, 3, stock("^NDX")), null);

  const falling = analyzeFundIndex({ name: "קסם ממונפת פי 3 NDX100", id: "1146976", indexSymbol: "^NDX", indexName: "Nasdaq 100",
    candles: path([[0, 200], [260, 120]]), fundPrice: 32210, riskOff: false })!;
  assert.equal(falling.leverage, 3);
  assert.equal(falling.market, "US");
  assert.equal(falling.trigger?.aboveSma200, false);
  assert.equal(falling.action, "צמצום / מכירה");
  assert.equal(falling.horizon.method, falling.method);
  const rising = analyzeFundIndex({ name: "הראל <b>", id: "1233170", indexSymbol: "207.TA", indexName: "ת\"א ביטחוניות",
    candles: path([[0, 100], [220, 160]]), historySymbol: "HRL-F238.TA", historyNote: "היסטוריה מהקרן", fundPrice: 2928, riskOff: false })!;
  assert.equal(rising.leverage, 1);
  assert.equal(rising.market, "TASE");
  assert.notEqual(rising.action, "צמצום / מכירה");
  if (rising.fund && rising.analysis.risk) assert.ok(Math.abs(rising.fund.riskPct - rising.analysis.risk.riskPct) < 1e-9);
  assert.equal(analyzeFundIndex({ name: "x", id: "1", indexSymbol: "^N225", indexName: "N", candles: path([[0, 1], [10, 2]]), fundPrice: 1, riskOff: false }), null);

  const html = renderFundIndexSection([falling, rising]);
  assert.ok(html.includes("הראל &lt;b&gt;") && !html.includes("הראל <b>"));
  assert.ok(html.includes("היסטוריה: HRL-F238.TA") && html.includes("היסטוריה מהקרן"));
  assert.ok(html.includes("צמצום / מכירה"));
  assert.equal(renderFundIndexSection([]), "");
});

test("marketOf and fetchIndexHistory fall back to the 1:1 tracker only when the index has no history", async () => {
  assert.deepEqual(["DSCT.TA", "AAPL", "BRK-B", "^NDX", "^N225", "000001.SS", "BZ=F"].map(marketOf), ["TASE", "US", "US", "US", "OTHER", "OTHER", "OTHER"]);
  const calls: string[] = [];
  const fetcher = async (symbol: string): Promise<Candle[]> => {
    calls.push(symbol);
    return symbol === "207.TA" ? path([[0, 100], [0, 100]]) : symbol === "HRL-F238.TA" ? path([[0, 100], [214, 120]]) : path([[0, 100], [299, 110]]);
  };
  const defense = await fetchIndexHistory("207.TA", 730, fetcher);
  assert.equal(defense.source, "HRL-F238.TA");
  assert.equal(defense.candles.length, 215);
  assert.match(defense.note ?? "", /1:1/);
  const ta35 = await fetchIndexHistory("TA35.TA", 730, fetcher);
  assert.equal(ta35.source, "TA35.TA");
  assert.deepEqual(calls, ["207.TA", "HRL-F238.TA", "TA35.TA"]);
});

test("per-market lists split buys by exchange, use each market's regime, and place funds by their index", () => {
  const regimeOf = (label: MarketRegime["label"], name: string): MarketRegime => ({
    benchmarkSymbol: name, benchmarkName: name, price: 1, aboveSma200: true, trendUp: true, breadthPct: 50, advancers: 1, decliners: 1,
    newHighs: 0, newLows: 0, score: label === "ריסק-אוף" ? -48 : 30, label, notes: [],
  });
  const falling = stock("C.TA", "הימנעות / מכירה");
  falling.score = -20;
  falling.signals = ["🔔 קרוס דובי 5/13"];
  const results = [stock("A.TA"), stock("B.TA"), stock("AAPL"), stock("MSFT"), falling];
  const horizons = new Map<string, HorizonInfo>([["A.TA", hz(60)], ["B.TA", hz(90)], ["AAPL", hz(70)], ["MSFT", hz(95)], ["C.TA", hz(5)]]);
  const fund = (name: string, market: FundIndexView["market"], action: FundIndexView["action"]) =>
    ({ name, id: "1", indexName: market === "US" ? "Nasdaq 100" : 'ת"א 35', market, action, reasons: ["סיבה"], fund: null, fundPrice: 100 }) as unknown as FundIndexView;
  const input = {
    mode: "daily", results, indices: [], newsByStock: new Map(), generatedAt: new Date(), horizons,
    regime: regimeOf("ריסק-אוף", 'ת"א 125'), usRegime: regimeOf("ריסק-און", "S&P 500"),
    fundViews: [fund("NDX x3", "US", "צמצום / מכירה"), fund("TA35 x3", "TASE", "קנייה / חיזוק"), fund("Nikkei", "OTHER", "החזקה")],
  } as unknown as ReportHtmlInput;
  const [tase, us, other] = marketRecommendations(input);
  assert.deepEqual([tase.market, us.market, other.market], ["TASE", "US", "OTHER"]);
  assert.deepEqual([tase.pick.main?.r.symbol, tase.pick.alts.map((x) => x.r.symbol)], ["B.TA", ["A.TA"]]);
  assert.deepEqual([us.pick.main?.r.symbol, us.pick.alts.map((x) => x.r.symbol)], ["MSFT", ["AAPL"]]);
  assert.match(tase.pick.regimeNote ?? "", /ריסק-אוף/);
  assert.match(us.pick.regimeNote ?? "", /ריסק-און/);
  assert.deepEqual(us.sells.map((s) => s.name), ["NDX x3"]);
  assert.deepEqual(tase.fundBuys.map((f) => f.name), ["TA35 x3"]);
  assert.deepEqual(tase.avoid.map((a) => a.symbol), ["C.TA"]);
  assert.equal(other.analyzed, 0);
  const html = renderMarketRecsSection(input);
  assert.ok(html.includes("תל אביב") && html.includes('ארה"ב') && html.includes("צמצום / מכירה (לפי Nasdaq 100)"));
});
