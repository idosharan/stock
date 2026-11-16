/**
 * הלוגיקה המרכזית של האייג'נט — משותפת ל-CLI ולשרת ה-Web.
 * מבצעת: משיכת חדשות, ניתוח כל מניה, והפקת דוח.
 */
import { WATCHLIST, PARAMS, PORTFOLIO, BENCHMARKS, WORLD_INDICES, FETCH, STOCK_SECTORS, GRADES_IN_RANKING, GEO_FEEDS, FOLLOWED_CHANNELS, CREATOR_ALIASES, UNDERLYING_TRIGGERS } from "./config.js";
import {
  fetchCandles, resampleWeekly, fetchInvestingPrice, fetchTasePrice, fetchBizportalQuote, getQuoteTime, ensureTls,
  getRateLimitHits, mapPool, barDates, findStaleSymbols, type Candle,
} from "./data.js";
import { fetchAllNews, fetchGeoNews, dedupeNews, matchNewsForStock, fetchFollowedVideos, markNewVideos, findMentions, buildCreatorView, methodCheck, rememberVideos, type StockNews, type HoldingRuleInput, type VideoCache } from "./news.js";
import {
  analyzeStock,
  analyzeLongTerm,
  buildHorizonInfo,
  type AnalysisResult,
  type HorizonInfo,
} from "./analysis.js";
import { getFundamentals, getDroppedFundamentals, type Fundamentals } from "./fundamentals.js";
import { gradeUniverse, appendGradeHistory, starRating, type GradeHistory, type GradeValidation, type GradeKey } from "./grades.js";
import { analyzeWorldIndices, fetchIndexHistory, type IndexAnalysis } from "./indices.js";
import { computeRegime, type MarketRegime } from "./regime.js";
import { correlationPairs, beta, type CorrPair } from "./risk.js";
import { generateReport, type Mode } from "./report.js";
import { historicalForecast, validateEvents, type HistoricalForecast, type HistoricalEvent } from "./forecast.js";
import { DocumentStore } from "./storage.js";
import {
  rawFactors, scoreUniverse, leverageTrigger, hybridRecommendation, macroFlags, geoHeadlineIntensity, sensitivityMatrix, leverageOf,
  appendGeoHistory, rsRatings, accumulationRatio, pivotExtension, topUpZone, underlyingStatus, type GeoHistoryEntry, type UnderlyingStatus,
  EQUAL_WEIGHTS, RESEARCH_WEIGHTS, MACRO_SYMBOLS, type LeverageTrigger, type MacroSeries, type EngineValidation,
  analyzeFundIndex, marketOf, type FundIndexView,
} from "./engine.js";
import { join } from "node:path";
import type { DataHealth, QuoteStamp } from "./summary.js";
import { CollectionBudget } from "./collection-budget.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** פער מחיר מקסימלי מול אתר הבורסה לפני שמתריעים על נתון חשוד. */
const PRICE_DEVIATION_WARN_PCT = 1.5;

const FINANCIAL_SECTORS = new Set(["בנקים", "ביטוח", "פיננסים חוץ-בנקאי"]);
const STATE_PATH = (): string => join(process.cwd(), "reports", "state.sqlite");

function readState<T>(key: string): T | undefined {
  const store = new DocumentStore(STATE_PATH());
  try {
    return store.get<T>(key);
  } finally {
    store.close();
  }
}

function writeState<T>(key: string, value: T): void {
  const store = new DocumentStore(STATE_PATH());
  try {
    store.set(key, value);
  } finally {
    store.close();
  }
}

export interface PriceCheck {
  symbol: string;
  name: string;
  yahoo: number;
  tase: number;
  deviationPct: number;
}

export interface BetaEntry {
  symbol: string;
  name: string;
  beta: number;
}

export interface RunResult {
  mode: Mode;
  results: AnalysisResult[];
  indices: IndexAnalysis[];
  newsByStock: Map<string, StockNews>;
  generatedAt: Date;
  reportPath: string;
  newsCount: number;
  regime: MarketRegime | null;
  correlations: CorrPair[];
  priceChecks: PriceCheck[];
  dataHealth: DataHealth;
}

function recordDailyBarDate(health: DataHealth, symbol: string, candles: Awaited<ReturnType<typeof fetchCandles>>): void {
  const latest = candles.at(-1)?.date;
  health.latestBarDates[symbol] = latest && Number.isFinite(latest.getTime()) ? latest.toISOString().slice(0, 10) : null;
}

/** מושך את מדד הייחוס עם נפילה חזרה לסימול חלופי אם הראשי אינו זמין. */
async function fetchBenchmark(
  def: { symbol: string; fallback: string; name: string },
  days: number,
  log: (m: string) => void,
  health: DataHealth,
  collection: CollectionBudget
): Promise<{ symbol: string; name: string; closes: number[]; candles: Awaited<ReturnType<typeof fetchCandles>> } | null> {
  for (const sym of [def.symbol, def.fallback]) {
    health.latestBarDates[sym] = null;
    try {
      const candles = await collection.run(`${sym}:benchmark`, () => fetchCandles(sym, days), []);
      recordDailyBarDate(health, sym, candles);
      if (candles.length > 60) {
        return { symbol: sym, name: def.name, closes: candles.map((c) => c.close), candles };
      }
      health.warnings.push(`מדד ייחוס ${sym}: אין מספיק נתונים`);
    } catch (err) {
      health.warnings.push(`מדד ייחוס ${sym}: ${(err as Error).message}`);
      log(`   ⚠️  מדד ייחוס ${sym}: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Adoption decision written by `npm run backtest`; null until a validation has been run. */
function loadEngineValidation(): EngineValidation | null {
  const value = readState<EngineValidation>("engine-validation");
  return value?.version === 1 ? value : null;
}

/**
 * מריץ ניתוח מלא. ניתן להעביר onProgress לקבלת עדכוני התקדמות (לשרת/לוג).
 */
export async function runAnalysis(
  mode: Mode,
  onProgress?: (msg: string) => void
): Promise<RunResult> {
  const log = (m: string) => {
    onProgress?.(m);
    console.log(m);
  };
  const generatedAt = new Date();
  const dataHealth: DataHealth = {
    expected: WATCHLIST.length, analyzed: 0,
    latestBarDates: Object.fromEntries(WATCHLIST.map((stock) => [stock.symbol, null])),
    missingSymbols: [], failures: {}, warnings: [],
  };
  const collection = new CollectionBudget(label => {
    dataHealth.failures[label] = "מקור הנתונים דולג בגלל מגבלת זמן; הדוח כולל רק נתונים שהתקבלו.";
    log(`איסוף חלקי: ${label} - מגבלת זמן; ממשיך עם הנתונים הזמינים.`);
  });
  const historicalForecasts = new Map<string, HistoricalForecast>();
  let events: HistoricalEvent[] = [];
  const eventStore = new DocumentStore(join(process.cwd(), 'reports', 'state.sqlite'));
  try {
    events = validateEvents(eventStore.get('events') ?? []);
  } finally { eventStore.close(); }
  log(`▶️  מריץ ניתוח (${mode}) עבור ${WATCHLIST.length} מניות...`);

  await collection.run("connectivity", ensureTls, undefined);

  log("📰 מושך כתבות מהעיתונות הכלכלית...");
  const allNews = await collection.run("news", fetchAllNews, []);
  if (!allNews.length) dataHealth.warnings.push("לא התקבלו חדשות; שכבת החדשות חסרה.");
  log(`   נמצאו ${allNews.length} כתבות.`);
  log("🌍 מושך כותרות גאופוליטיות מפידים עולמיים...");
  const geoNews = await collection.run("geo-news", fetchGeoNews, []);
  if (!geoNews.length) dataHealth.warnings.push("לא התקבלו כותרות מהפידים העולמיים; מדד הגאופוליטיקה מבוסס על העיתונות הכלכלית בלבד.");
  log(`   נמצאו ${geoNews.length} כותרות עולמיות.`);
  log("🎥 בודק סרטונים מערוצים במעקב...");
  const videoCache = readState<VideoCache>("creator-videos") ?? {};
  const creatorFeed = await collection.run("creator-feed", () => fetchFollowedVideos(FOLLOWED_CHANNELS, videoCache), []);
  if (!creatorFeed.length) dataHealth.warnings.push("לא התקבלו סרטונים מהערוצים במעקב (יוטיוב).");
  const titleOnly = creatorFeed.filter((v) => v.source === "channel").length;
  if (titleOnly) dataHealth.warnings.push(`יוטיוב: ${titleOnly} מתוך ${creatorFeed.length} סרטונים התקבלו עם כותרת בלבד (עמוד הצפייה נחסם); האזכורים שלהם לפי הכותרת.`);
  if (mode === "daily" && creatorFeed.length) writeState("creator-videos", rememberVideos(videoCache, creatorFeed));
  log(`   נמצאו ${creatorFeed.length} סרטונים.`);

  const results: AnalysisResult[] = [];
  const newsByStock = new Map<string, StockNews>();
  // מחיר אחרון לניירות ללא מספיק היסטוריה לניתוח (להצגה במקטע התיק)
  const extraPrices = new Map<string, number>();
  // אופקים נוספים (שבועי + ארוך טווח) לדוח המשולב היומי
  const horizons = new Map<string, HorizonInfo>();
  // סדרות סגירה לכל מניה — לרוחב שוק, מתאמים וגרפי מיני
  const closesBySymbol = new Map<string, number[]>();

  // בכל מצב מושכים טווח ארוך (שנתיים) — נדרש לנרות שבועיים ולניתוח ארוך טווח (SMA200).
  const historyDays = PARAMS.historyDaysWeekly;

  log("📊 מושך מדדי ייחוס לחישוב חוזק יחסי ומצב שוק...");
  const benchIsrael = await fetchBenchmark(BENCHMARKS.israel, historyDays, log, dataHealth, collection);
  const benchWorld = await fetchBenchmark(BENCHMARKS.world, historyDays, log, dataHealth, collection);
  if (benchIsrael) log(`   ✅ ${benchIsrael.name} (${benchIsrael.symbol})`);
  if (benchWorld) log(`   ✅ ${benchWorld.name} (${benchWorld.symbol})`);

  const candlesBySymbol = new Map<string, Candle[]>();
  const fundamentalsBySymbol = new Map<string, Fundamentals>();
  const outcomes = await mapPool(WATCHLIST, async (stock) => {
    if (collection.expired) {
      return { stock, daily: [] as Candle[], news: null, forecast: null, result: null, horizon: null, fundamentals: null as Fundamentals | null, error: null as string | null, skipped: true };
    }
    try {
      const daily = await collection.run(stock.symbol, () => fetchCandles(stock.symbol, historyDays), []);
      const candles = mode === "weekly" ? resampleWeekly(daily) : daily;
      const news = matchNewsForStock(allNews, stock.name);
      const fundamentals = await collection.run(`${stock.symbol}:fundamentals`, () => getFundamentals(stock.symbol), null);
      const bench = stock.symbol.endsWith(".TA") ? benchIsrael : benchWorld;
      const forecast = historicalForecast({ symbol: stock.symbol, candles: daily, benchmark: bench?.candles, asOf: generatedAt, events });
      const context = bench
        ? { benchmarkCloses: mode === "weekly" ? resampleWeekly(bench.candles).map((c) => c.close) : bench.closes, benchmarkName: bench.name }
        : undefined;
      const result = analyzeStock(stock.symbol, stock.name, candles, { symbol: stock.symbol }, news, fundamentals, context);
      let horizon: HorizonInfo | null = null;
      if (result && mode === "daily") {
        // אופק שבועי: אותו מנוע על נרות שבועיים; אופק ארוך: SMA200/מומנטום/שיא 52 שב'
        const wRes = analyzeStock(stock.symbol, stock.name, resampleWeekly(daily), { symbol: stock.symbol }, news, fundamentals,
          bench ? { benchmarkCloses: resampleWeekly(bench.candles).map((c) => c.close), benchmarkName: bench.name } : undefined);
        horizon = buildHorizonInfo(result.score, wRes ? { score: wRes.score, recommendation: wRes.recommendation } : null, analyzeLongTerm(daily));
        horizon.method = methodCheck(daily, result.earningsInDays ?? null);
      }
      return { stock, daily, news, forecast, result, horizon, fundamentals, error: null as string | null, skipped: false };
    } catch (err) {
      return { stock, daily: [] as Candle[], news: null, forecast: null, result: null, horizon: null, fundamentals: null as Fundamentals | null, error: (err as Error).message, skipped: false };
    } finally {
      if (!collection.expired) await sleep(300);
    }
  }, { concurrency: FETCH.concurrency, throttled: () => getRateLimitHits() > 0 });

  for (const outcome of outcomes) {
    const { stock, daily, result } = outcome;
    if (outcome.skipped) continue;
    if (outcome.fundamentals) fundamentalsBySymbol.set(stock.symbol, outcome.fundamentals);
    if (outcome.error != null) {
      dataHealth.failures[stock.symbol] = outcome.error;
      log(`   ❌ ${stock.name} (${stock.symbol}): שגיאה — ${outcome.error}`);
      continue;
    }
    recordDailyBarDate(dataHealth, stock.symbol, daily);
    const lastClose = daily.at(-1)?.close;
    if (lastClose != null && Number.isFinite(lastClose) && lastClose > 0) extraPrices.set(stock.symbol, lastClose);
    if (outcome.news) newsByStock.set(stock.symbol, outcome.news);
    if (outcome.forecast) historicalForecasts.set(stock.symbol, outcome.forecast);
    if (daily.length) {
      closesBySymbol.set(stock.symbol, daily.map((c) => c.close));
      candlesBySymbol.set(stock.symbol, daily);
    }
    if (result) {
      results.push(result);
      if (outcome.horizon) horizons.set(stock.symbol, outcome.horizon);
      log(`   ✅ ${stock.name} (${stock.symbol}): ${result.recommendation} | ציון ${result.score}`);
    } else {
      dataHealth.failures[stock.symbol] ??= "אין מספיק נתונים לניתוח";
      log(`   ⚠️  ${stock.name} (${stock.symbol}): אין מספיק נתונים.`);
    }
  }
  dataHealth.analyzed = results.length;
  if (getRateLimitHits() > 0) dataHealth.warnings.push(`חסימת קצב (429) ×${getRateLimitHits()} — המשיכה עברה לנתיב יחיד.`);

  const analyzedSymbols = new Set(results.map((result) => result.symbol));
  dataHealth.missingSymbols = WATCHLIST.filter((stock) => !analyzedSymbols.has(stock.symbol)).map((stock) => stock.symbol);
  if (collection.expired) {
    dataHealth.warnings.push("תקציב איסוף הנתונים של חמש דקות הסתיים; נותר זמן לשמירת דוח חלקי.");
    for (const symbol of dataHealth.missingSymbols) dataHealth.failures[symbol] ??= "לא נאסף בגלל מגבלת זמן כוללת.";
  }
  if (!results.length) throw new Error("אין תוצאות ניתוח; הדוח וההיסטוריה הקודמים נשמרו");
  if (dataHealth.missingSymbols.length) log(`איסוף חלקי: נותחו ${dataHealth.analyzed} מתוך ${dataHealth.expected} מניות.`);

  // Yahoo sometimes drops a .TA session — compare bar dates with the Israeli benchmark
  const staleSymbols = benchIsrael
    ? findStaleSymbols(new Map([...candlesBySymbol].map(([symbol, candles]) => [symbol, barDates(candles)])), barDates(benchIsrael.candles))
    : [];
  for (const symbol of staleSymbols) {
    dataHealth.warnings.push(`${symbol}: נר יומי חסר או מפגר אחרי ${benchIsrael!.name}; הוחרג מרוחב השוק ומהמלצת היום.`);
    const hz = horizons.get(symbol);
    if (hz) hz.stale = true;
  }
  const staleSet = new Set(staleSymbols);

  // מצב שוק ורוחב שוק — מסנן-על להמלצות
  let regime: MarketRegime | null = null;
  if (benchIsrael) {
    regime = computeRegime(
      { symbol: benchIsrael.symbol, name: benchIsrael.name, candles: benchIsrael.candles },
      [...closesBySymbol]
        .filter(([sym]) => sym.endsWith(".TA") && !staleSet.has(sym))
        .map(([symbol, closes]) => ({ symbol, closes }))
    );
    if (regime) log(`🧭 מצב שוק: ${regime.label} (ציון ${regime.score}, רוחב ${regime.breadthPct.toFixed(0)}%)`);
  }
  // US names get their own regime (S&P 500 + US breadth) — the Israeli one no longer gates US buys
  let usRegime: MarketRegime | null = null;
  if (benchWorld) {
    usRegime = computeRegime(
      { symbol: benchWorld.symbol, name: benchWorld.name, candles: benchWorld.candles },
      [...closesBySymbol].filter(([sym]) => marketOf(sym) === "US").map(([symbol, closes]) => ({ symbol, closes }))
    );
    if (usRegime) log(`🧭 מצב שוק ארה"ב: ${usRegime.label} (ציון ${usRegime.score}, רוחב ${usRegime.breadthPct.toFixed(0)}%)`);
  }
  const regimeOf = (symbol: string): MarketRegime | null => {
    const market = marketOf(symbol);
    return market === "TASE" ? regime : market === "US" ? usRegime : null;
  };

  // ציון פקטורים חתך-רוחבי; המנוע ההיברידי מחליף המלצות רק אחרי אימות היסטורי
  const engine = loadEngineValidation();
  const factorEntries = results.flatMap((r) => {
    const raw = rawFactors(candlesBySymbol.get(r.symbol)?.map((c) => c.close) ?? []);
    return raw ? [{ symbol: r.symbol, raw }] : [];
  });
  const factorScores = scoreUniverse(factorEntries, engine?.adopted && engine.chosen === "V1" ? EQUAL_WEIGHTS : RESEARCH_WEIGHTS);
  const hybrid = mode === "daily" && engine?.adopted === true;
  for (const r of results) {
    const hz = horizons.get(r.symbol);
    const factor = factorScores.get(r.symbol);
    if (!hz || !factor) continue;
    hz.factor = factor;
    if (!hybrid) continue;
    const decision = hybridRecommendation({
      rank: factor.rank, riskOff: regimeOf(r.symbol)?.label === "ריסק-אוף", aboveSma200: factor.aboveSma200, freshSell: r.timing?.freshSell ?? false,
    });
    r.recommendation = decision.recommendation;
    hz.ranking = factor.score;
    hz.engine = "hybrid";
    hz.waitForConfirmation = decision.waitForConfirmation;
    if (decision.waitForConfirmation) {
      r.signals.push(`⏳ דירוג פקטורים גבוה אך יש אות מכירה טרי (${r.timing!.reasons.join(", ")}) — קנייה רק אחרי אישור.`);
    }
  }
  if (factorEntries.length) {
    log(`📐 ציון פקטורים ל-${factorEntries.length} ניירות — ${hybrid ? `מנוע היברידי פעיל (${engine!.chosen})` : "מוצג בלבד"}.`);
  }

  // ציוני ראיות A–F: מוצגים ונעקבים קדימה; נכנסים לדירוג רק אם אושרו ב-GRADES_IN_RANKING
  const grades = gradeUniverse(results.map((r) => ({
    symbol: r.symbol,
    f: fundamentalsBySymbol.get(r.symbol) ?? null,
    factor: factorScores.get(r.symbol),
    financial: FINANCIAL_SECTORS.has(STOCK_SECTORS[r.symbol] ?? ""),
    sector: STOCK_SECTORS[r.symbol],
    price: r.price,
    accumulation: accumulationRatio(candlesBySymbol.get(r.symbol) ?? []),
  })));
  const rs = rsRatings(results.map((r) => ({ symbol: r.symbol, closes: candlesBySymbol.get(r.symbol)?.map((c) => c.close) ?? [] })));
  const coreSymbols = new Set(PORTFOLIO.filter((h) => h.core && h.symbol).map((h) => h.symbol!));
  for (const r of results) {
    const hz = horizons.get(r.symbol);
    if (!hz) continue;
    hz.crowd = fundamentalsBySymbol.get(r.symbol)?.crowd ?? null;
    hz.rs = rs.get(r.symbol) ?? null;
    hz.extended = pivotExtension(candlesBySymbol.get(r.symbol) ?? []);
    if (coreSymbols.has(r.symbol)) {
      hz.topUp = topUpZone({
        closes: candlesBySymbol.get(r.symbol)?.map((c) => c.close) ?? [r.price],
        rsi: r.indicators.rsi, stars: starRating(r.price, hz.crowd)?.stars ?? null,
        earningsInDays: r.earningsInDays, longTerm: hz.longTerm?.label ?? null,
      });
    }
  }
  for (const r of results) {
    const hz = horizons.get(r.symbol);
    const g = grades.get(r.symbol);
    if (!hz || !g) continue;
    hz.grades = g;
    if (hybrid && hz.factor && GRADES_IN_RANKING.length) {
      const parts = [hz.factor.rank, ...GRADES_IN_RANKING.map((k) => g.pct[k]).filter((v): v is number => v != null)];
      hz.ranking = Math.round((parts.reduce((s, x) => s + x, 0) / parts.length - 50) * 2);
    }
    if (g.redFlags.length) log(`   🚩 ${r.name} (${r.symbol}): ${g.redFlags.join("; ")}`);
  }
  const graded = [...grades.values()];
  const coverage = (k: GradeKey) => graded.filter((g) => g.letters[k] != null).length;
  dataHealth.warnings.push(`ציוני ראיות: רוויזיות ${coverage("revisions")}, הפתעות ${coverage("surprise")}, איכות ${coverage("quality")}, שווי ${coverage("value")}, קונצנזוס ${coverage("consensus")}, ביקוש ${coverage("demand")} מתוך ${results.length} ניירות.`);
  if (getDroppedFundamentals() > 0) {
    dataHealth.warnings.push(`${getDroppedFundamentals()} ערכים פונדמנטליים חריגים נזרקו (מחוץ לטווח סביר).`);
  }
  // תאריך הסשן האחרון שנסגר — התשואה קדימה נמדדת מפתיחת הסשן שאחריו, בלי הצצה לעתיד
  const israelDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(generatedAt);
  const gradeDate = benchIsrael?.candles.at(-1)?.date.toISOString().slice(0, 10) ?? israelDate;
  if (mode === "daily") {
    const snapshot = Object.fromEntries([...grades].map(([symbol, g]) => [
      symbol, Object.fromEntries(Object.entries(g.pct).filter(([, v]) => v != null)),
    ]));
    writeState("grade-history", appendGradeHistory(readState<GradeHistory>("grade-history") ?? {}, gradeDate, snapshot));
  }
  const gradeValidation = readState<GradeValidation>("grade-validation") ?? null;

  // ריכוזיות התיק — מתאמים גבוהים בין ההחזקות ובטא מול מדד הייחוס
  const heldSeries = new Map<string, { name: string; closes: number[] }>();
  for (const h of PORTFOLIO) {
    if (!h.symbol) continue;
    const closes = closesBySymbol.get(h.symbol);
    if (closes) heldSeries.set(h.symbol, { name: h.name, closes });
  }
  const correlations = correlationPairs(heldSeries);
  const betas: BetaEntry[] = [];
  for (const [sym, s] of heldSeries) {
    const benchCloses = sym.endsWith(".TA") ? benchIsrael?.closes : benchWorld?.closes;
    if (!benchCloses) continue;
    const b = beta(s.closes, benchCloses);
    if (b != null) betas.push({ symbol: sym, name: s.name, beta: b });
  }

  const indices = await analyzeWorldIndices(mode, onProgress, collection);
  const analyzedIndices = new Set(indices.map((index) => index.symbol));
  const sparkCloses = new Map<string, number[]>();
  for (const index of WORLD_INDICES) {
    if (!analyzedIndices.has(index.symbol)) {
      dataHealth.latestBarDates[index.symbol] ??= null;
      dataHealth.warnings.push(`אין ניתוח מדד ${index.symbol}; נתונים חסרים או היסטוריה קצרה.`);
    }
  }
  for (const index of indices) {
    try {
      const { candles } = await collection.run(`${index.symbol}:history`, () => fetchIndexHistory(index.symbol, historyDays, fetchCandles), { candles: [] as Candle[], source: index.symbol });
      recordDailyBarDate(dataHealth, index.symbol, candles);
      sparkCloses.set(index.symbol, candles.slice(-30).map((c) => c.close));
      historicalForecasts.set(index.symbol, historicalForecast({ symbol: index.symbol, candles, asOf: generatedAt, events }));
    } catch (error) {
      dataHealth.latestBarDates[index.symbol] ??= null;
      dataHealth.warnings.push(`היסטוריה חסרה למדד ${index.symbol}: ${(error as Error).message}`);
      log(`   היסטוריה חסרה למדד ${index.symbol}: ${(error as Error).message}`);
    }
  }

  const historyFor = new Map<string, Candle[]>();
  /** Symbol whose candles stand in for an index without history (see INDEX_HISTORY_PROXY). */
  const historySource = new Map<string, { source: string; note?: string }>();
  const candlesFor = async (symbol: string): Promise<Candle[] | undefined> => {
    if (historyFor.has(symbol)) return historyFor.get(symbol);
    try {
      const history = await collection.run(`${symbol}:history`, () => fetchIndexHistory(symbol, historyDays, fetchCandles), { candles: [] as Candle[], source: symbol });
      if (!history.candles.length) return undefined;
      historyFor.set(symbol, history.candles);
      if (history.source !== symbol) {
        historySource.set(symbol, { source: history.source, note: history.note });
        dataHealth.warnings.push(`${symbol}: ${history.note ?? `היסטוריה מ-${history.source}`}.`);
      }
      return history.candles;
    } catch (error) {
      dataHealth.warnings.push(`היסטוריה חסרה ל-${symbol}: ${(error as Error).message}`);
      return undefined;
    }
  };

  const leverageTriggers = new Map<string, LeverageTrigger>();
  for (const symbol of new Set(PORTFOLIO.flatMap((h) => (h.triggerIndex ? [h.triggerIndex] : [])))) {
    const candles = await candlesFor(symbol);
    const trigger = candles ? leverageTrigger(candles.map((c) => c.close)) : null;
    if (trigger) leverageTriggers.set(symbol, trigger);
  }

  const macroSeries: MacroSeries = {};
  for (const [key, symbol] of Object.entries(MACRO_SYMBOLS) as Array<[keyof MacroSeries, string]>) {
    macroSeries[key] = await candlesFor(symbol);
  }
  const geoHistory = (readState<GeoHistoryEntry[]>("geo-history") ?? []).filter((h) => h.date !== israelDate);
  const topicFeeds = new Set(GEO_FEEDS.filter((f) => f.topic).map((f) => f.name));
  const geo = geoHeadlineIntensity(
    dedupeNews([...allNews, ...geoNews.filter((n) => !topicFeeds.has(n.source))]),
    geoHistory,
    geoNews.filter((n) => topicFeeds.has(n.source))
  );
  if (mode === "daily") {
    writeState("geo-history", appendGeoHistory(geoHistory, { date: israelDate, share: geo.share, count: geo.count, total: geo.total }));
  }
  const macro = { flags: macroFlags(macroSeries), geo, underlying: [] as UnderlyingStatus[] };
  for (const rule of UNDERLYING_TRIGGERS) {
    const status = underlyingStatus(rule, await candlesFor(rule.symbol));
    if (status) macro.underlying.push(status);
    else dataHealth.warnings.push(`טריגר ${rule.name} (${rule.symbol}): אין מחיר בהרצה זו.`);
  }
  log(`🌍 עוצמת כותרות גאופוליטיות: ${geo.level} (${geo.count}/${geo.total}${geo.percentile != null ? `, אחוזון ${geo.percentile}` : ""})`);
  if (regime) regime.macroFlags = macro.flags;
  if (usRegime) usRegime.macroFlags = macro.flags;
  if (macro.flags.length) log(`🌐 דגלי מאקרו: ${macro.flags.map((f) => f.label).join(", ")}`);

  const exposureInputs = PORTFOLIO.flatMap((h): Parameters<typeof sensitivityMatrix>[0] => {
    const own = h.symbol ? candlesBySymbol.get(h.symbol) : undefined;
    if (own) return [{ name: h.name, symbol: h.symbol!, candles: own, usdDenominated: !h.symbol!.endsWith(".TA") }];
    const proxy = h.triggerIndex ? historyFor.get(h.triggerIndex) : undefined;
    return proxy ? [{ name: `${h.name} (לפי ${h.triggerIndex})`, symbol: h.triggerIndex!, candles: proxy, leverage: leverageOf(h.name) }] : [];
  });
  const exposure = sensitivityMatrix(exposureInputs, {
    ndx: await candlesFor("^NDX"),
    brent: macroSeries.brent,
    ta35: await candlesFor("TA35.TA"),
    usdils: macroSeries.usdils,
  });

  // Quote-only ETFs are not on Yahoo: Bizportal by security number first, then investing.com, then the TASE site.
  const quoteStamps = new Map<string, QuoteStamp>();
  const quoteHoldings = PORTFOLIO.filter((h) => !h.symbol && (h.taseNumber || h.investingUrl));
  if (quoteHoldings.length) {
    log(`💹 מושך מחירי קרנות סל (${quoteHoldings.length} ניירות)...`);
    for (const h of quoteHoldings) {
      const identifier = h.taseNumber ?? h.name;
      dataHealth.warnings.push(`${identifier}: מחיר בלבד, ללא ניתוח טכני.`);
      const valid = (value: number | null): value is number => value != null && Number.isFinite(value) && value > 0;
      let price: number | null = null;
      let source = "";
      let failure: string | undefined;
      if (h.taseNumber) {
        try {
          const biz = await collection.run(`${identifier}:bizportal`, () => fetchBizportalQuote(h.taseNumber!), null);
          if (biz && valid(biz.price)) {
            price = biz.price;
            source = biz.source;
            if (biz.asOf) quoteStamps.set(h.name, { at: biz.asOf, source: biz.source });
          }
        } catch (error) {
          failure = (error as Error).message;
        }
      }
      if (!valid(price) && h.investingUrl && !collection.expired) {
        try {
          price = await collection.run(identifier, () => fetchInvestingPrice(h.investingUrl!), null);
          source = "investing.com";
        } catch (error) {
          failure = failure ? `${failure}; ${(error as Error).message}` : (error as Error).message;
        }
      }
      if (!valid(price) && h.taseNumber && !collection.expired) {
        log(`   🔁 ${h.name}: מנסה מחיר לפי מספר נייר ${h.taseNumber} מאתר הבורסה...`);
        try {
          price = await collection.run(`${identifier}:tase`, () => fetchTasePrice(h.taseNumber!), null);
          source = "אתר הבורסה";
        } catch (error) {
          failure = failure ? `${failure}; גם אתר הבורסה נכשל: ${(error as Error).message}` : (error as Error).message;
        }
      }
      if (valid(price)) {
        extraPrices.set(h.name, price);
        delete dataHealth.failures[identifier];
        delete dataHealth.failures[`${identifier}:bizportal`];
        delete dataHealth.failures[`${identifier}:tase`];
        log(`   ✅ ${h.name}: ${price.toLocaleString("he-IL")} (${source})`);
      } else {
        dataHealth.failures[identifier] ??= failure ?? "לא התקבל מחיר מ-Bizportal, מ-investing.com או מאתר הבורסה";
        log(`   ⚠️  ${h.name}: לא התקבל מחיר.`);
      }
      if (!collection.expired) await sleep(400);
    }
  }

  // Cross-check holding prices against a second source (Bizportal by TASE number, else investing.com).
  const priceChecks: PriceCheck[] = [];
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));
  for (const h of PORTFOLIO) {
    if (!h.symbol) continue;
    const time = getQuoteTime(h.symbol);
    if (time != null) quoteStamps.set(h.name, { at: new Date(time).toISOString(), source: "Yahoo" });
    if (!h.taseNumber && !h.investingUrl) continue;
    const r = bySymbol.get(h.symbol);
    if (!r) continue;
    let second: number | null;
    try {
      second = await collection.run(`${h.symbol}:verification`, async () => h.taseNumber
        ? (await fetchBizportalQuote(h.taseNumber))?.price ?? null
        : await fetchInvestingPrice(h.investingUrl!), null);
    } catch (error) {
      dataHealth.warnings.push(`${h.symbol}: אימות מחיר ממקור שני נכשל: ${(error as Error).message}`);
      continue;
    }
    if (second == null || !Number.isFinite(second) || second <= 0) {
      dataHealth.warnings.push(`${h.symbol}: אין אימות מחיר ממקור שני.`);
      continue;
    }
    const deviationPct = ((r.price - second) / second) * 100;
    priceChecks.push({ symbol: h.symbol, name: h.name, yahoo: r.price, tase: second, deviationPct });
    if (Math.abs(deviationPct) > PRICE_DEVIATION_WARN_PCT) {
      dataHealth.warnings.push(`${h.symbol}: פער מחיר ${deviationPct.toFixed(1)}% מול המקור השני; לאמת לפני פעולה.`);
      log(`   ⚠️  ${h.name}: פער מחיר ${deviationPct.toFixed(1)}% מול המקור השני (${second.toLocaleString("he-IL")}).`);
    }
    if (!collection.expired) await sleep(300);
  }

  for (const h of PORTFOLIO) {
    if (!h.symbol) continue;
    const closes = closesBySymbol.get(h.symbol);
    if (closes) sparkCloses.set(h.symbol, closes.slice(-60));
  }

  // Funds without their own chart: the full engine on the reference index, translated to the fund
  const fundViews: FundIndexView[] = [];
  for (const h of PORTFOLIO) {
    if (h.symbol || !h.triggerIndex) continue;
    const candles = collection.expired ? historyFor.get(h.triggerIndex) : await candlesFor(h.triggerIndex);
    const source = historySource.get(h.triggerIndex);
    const view = candles?.length ? analyzeFundIndex({
      name: h.name, id: h.taseNumber ?? h.name, indexSymbol: h.triggerIndex,
      indexName: WORLD_INDICES.find((i) => i.symbol === h.triggerIndex)?.name ?? h.triggerIndex,
      candles, historySymbol: source?.source, historyNote: source?.note,
      fundPrice: extraPrices.get(h.name) ?? null, riskOff: regimeOf(h.triggerIndex)?.label === "ריסק-אוף",
    }) : null;
    if (view) {
      fundViews.push(view);
      log(`   📈 ${h.name}: לפי ${view.indexName} — ${view.action} (משולב ${view.horizon.combined})`);
    } else {
      dataHealth.warnings.push(`${h.taseNumber ?? h.name}: אין מספיק היסטוריה למדד ${h.triggerIndex}; הקרן לא נותחה לפי המדד.`);
    }
  }

  // Followed creators: videos of the last 7 days, their mentions, and the watchlist scanned with the creator's chart method
  const marked = markNewVideos(creatorFeed, readState<Record<string, string>>("creator-seen") ?? {}, generatedAt.toISOString());
  if (mode === "daily" && creatorFeed.length) writeState("creator-seen", marked.seen);
  const recentVideos = marked.videos.filter((v) => Date.parse(v.published) >= generatedAt.getTime() - 7 * 86_400_000);
  const heldSymbols = new Set(PORTFOLIO.flatMap((h) => (h.symbol ? [h.symbol] : [])));
  const mentions = findMentions(recentVideos, WATCHLIST, heldSymbols, CREATOR_ALIASES);
  const setupCandles = new Map(candlesBySymbol);
  for (const m of mentions.filter((x) => !x.tracked).slice(0, 12)) {
    if (collection.expired) break;
    const extra = await candlesFor(m.symbol);
    if (extra) setupCandles.set(m.symbol, extra);
  }
  // The portfolio by his rules: a stock on its own chart, a fund on its reference index
  const earningsBySymbol = new Map(results.map((r) => [r.symbol, r.earningsInDays ?? null]));
  const portfolioRules: HoldingRuleInput[] = [];
  for (const h of PORTFOLIO) {
    if (h.symbol) {
      portfolioRules.push({ name: h.name, id: h.symbol, basis: "own", candles: candlesBySymbol.get(h.symbol), earningsInDays: earningsBySymbol.get(h.symbol) ?? null, sector: h.sector ?? STOCK_SECTORS[h.symbol] });
    } else {
      const candles = h.triggerIndex && !collection.expired ? await candlesFor(h.triggerIndex) : undefined;
      portfolioRules.push({ name: h.name, id: h.taseNumber ?? h.name, basis: "index", basisName: h.triggerIndex, candles, earningsInDays: null, sector: h.sector });
    }
  }
  // Built even without videos: the rules, the holdings and the setups do not depend on the feed
  const creator = FOLLOWED_CHANNELS.length ? buildCreatorView(FOLLOWED_CHANNELS.map((c) => c.name), recentVideos, mentions, {
    candles: setupCandles,
    names: new Map(WATCHLIST.filter((s) => candlesBySymbol.has(s.symbol)).map((s) => [s.symbol, s.name])),
    held: heldSymbols,
    results: new Map(results.map((r) => [r.symbol, { score: r.score, earningsInDays: r.earningsInDays ?? null }])),
    combined: new Map([...horizons].map(([symbol, hz]) => [symbol, hz.combined])),
    portfolio: portfolioRules,
  }) : undefined;
  if (creator) log(`🎥 ${recentVideos.filter((v) => v.isNew).length} סרטונים חדשים · ${creator.mentions.length} אזכורים · ${creator.setups.length} מבני שינוי מגמה ברשימת המעקב.`);

  const reportPath = await generateReport({
    mode,
    results,
    indices,
    newsByStock,
    allNews,
    generatedAt,
    extraPrices,
    horizons,
    regime,
    correlations,
    betas,
    priceChecks,
    sparkCloses,
    quoteStamps,
    historicalForecasts,
    dataHealth,
    leverageTriggers,
    macro,
    exposure,
    engine,
    gradeValidation,
    creator,
    fundViews,
    usRegime,
  });
  log(`📄 הדוח נוצר בהצלחה: ${reportPath}`);

  return {
    mode,
    results,
    indices,
    newsByStock,
    generatedAt,
    reportPath,
    newsCount: allNews.length,
    regime,
    correlations,
    priceChecks,
    dataHealth,
  };
}
