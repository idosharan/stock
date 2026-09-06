/**
 * הלוגיקה המרכזית של האייג'נט — משותפת ל-CLI ולשרת ה-Web.
 * מבצעת: משיכת חדשות, ניתוח כל מניה, והפקת דוח.
 */
import { WATCHLIST, PARAMS, PORTFOLIO, BENCHMARKS } from "./config.js";
import { fetchCandles, resampleWeekly, fetchInvestingPrice, fetchTasePrice, ensureTls } from "./data.js";
import { fetchAllNews, matchNewsForStock, type StockNews } from "./news.js";
import {
  analyzeStock,
  analyzeLongTerm,
  buildHorizonInfo,
  type AnalysisResult,
  type HorizonInfo,
} from "./analysis.js";
import { getFundamentals } from "./fundamentals.js";
import { analyzeWorldIndices, type IndexAnalysis } from "./indices.js";
import { computeRegime, type MarketRegime } from "./regime.js";
import { correlationPairs, beta, type CorrPair } from "./risk.js";
import { generateReport, type Mode } from "./report.js";
import { historicalForecast, validateEvents, type HistoricalForecast, type HistoricalEvent } from "./forecast.js";
import { DocumentStore } from "./storage.js";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** פער מחיר מקסימלי מול אתר הבורסה לפני שמתריעים על נתון חשוד. */
const PRICE_DEVIATION_WARN_PCT = 2;

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
}

/** מושך את מדד הייחוס עם נפילה חזרה לסימול חלופי אם הראשי אינו זמין. */
async function fetchBenchmark(
  def: { symbol: string; fallback: string; name: string },
  days: number,
  log: (m: string) => void
): Promise<{ symbol: string; name: string; closes: number[]; candles: Awaited<ReturnType<typeof fetchCandles>> } | null> {
  for (const sym of [def.symbol, def.fallback]) {
    try {
      const candles = await fetchCandles(sym, days);
      if (candles.length > 60) {
        return { symbol: sym, name: def.name, closes: candles.map((c) => c.close), candles };
      }
    } catch (err) {
      log(`   ⚠️  מדד ייחוס ${sym}: ${(err as Error).message}`);
    }
  }
  return null;
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
  const historicalForecasts = new Map<string, HistoricalForecast>();
  let events: HistoricalEvent[] = [];
  const eventStore = new DocumentStore(join(process.cwd(), 'reports', 'state.sqlite'));
  try {
    events = validateEvents(eventStore.get('events') ?? []);
  } finally { eventStore.close(); }
  log(`▶️  מריץ ניתוח (${mode}) עבור ${WATCHLIST.length} מניות...`);

  await ensureTls();

  log("📰 מושך כתבות מהעיתונות הכלכלית...");
  const allNews = await fetchAllNews();
  log(`   נמצאו ${allNews.length} כתבות.`);

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
  const benchIsrael = await fetchBenchmark(BENCHMARKS.israel, historyDays, log);
  const benchWorld = await fetchBenchmark(BENCHMARKS.world, historyDays, log);
  if (benchIsrael) log(`   ✅ ${benchIsrael.name} (${benchIsrael.symbol})`);
  if (benchWorld) log(`   ✅ ${benchWorld.name} (${benchWorld.symbol})`);

  for (const stock of WATCHLIST) {
    try {
      const daily = await fetchCandles(stock.symbol, historyDays);
      const candles = mode === "weekly" ? resampleWeekly(daily) : daily;
      const news = matchNewsForStock(allNews, stock.name);
      newsByStock.set(stock.symbol, news);
      const fundamentals = await getFundamentals(stock.symbol);
      const bench = stock.symbol.endsWith(".TA") ? benchIsrael : benchWorld;
      historicalForecasts.set(stock.symbol, historicalForecast({
        symbol: stock.symbol, candles: daily, benchmark: bench?.candles, asOf: generatedAt, events,
      }));
      const context = bench
        ? {
            benchmarkCloses:
              mode === "weekly" ? resampleWeekly(bench.candles).map((c) => c.close) : bench.closes,
            benchmarkName: bench.name,
          }
        : undefined;

      const result = analyzeStock(
        stock.symbol,
        stock.name,
        candles,
        { symbol: stock.symbol },
        news,
        fundamentals,
        context
      );
      if (daily.length) closesBySymbol.set(stock.symbol, daily.map((c) => c.close));
      if (result) {
        results.push(result);

        if (mode === "daily") {
          // אופק שבועי: אותו מנוע על נרות שבועיים; אופק ארוך: SMA200/מומנטום/שיא 52 שב'
          const wRes = analyzeStock(
            stock.symbol,
            stock.name,
            resampleWeekly(daily),
            { symbol: stock.symbol },
            news,
            fundamentals,
            bench
              ? { benchmarkCloses: resampleWeekly(bench.candles).map((c) => c.close), benchmarkName: bench.name }
              : undefined
          );
          const lt = analyzeLongTerm(daily);
          horizons.set(
            stock.symbol,
            buildHorizonInfo(result.score, wRes ? { score: wRes.score, recommendation: wRes.recommendation } : null, lt)
          );
        }

        log(`   ✅ ${stock.name} (${stock.symbol}): ${result.recommendation} | ציון ${result.score}`);
      } else {
        const lastClose = daily.length ? daily[daily.length - 1].close : null;
        if (lastClose != null) extraPrices.set(stock.symbol, lastClose);
        log(`   ⚠️  ${stock.name} (${stock.symbol}): אין מספיק נתונים.`);
      }
    } catch (err) {
      log(`   ❌ ${stock.name} (${stock.symbol}): שגיאה — ${(err as Error).message}`);
    }
    await sleep(300);
  }

  // מצב שוק ורוחב שוק — מסנן-על להמלצות
  let regime: MarketRegime | null = null;
  if (benchIsrael) {
    regime = computeRegime(
      { symbol: benchIsrael.symbol, name: benchIsrael.name, candles: benchIsrael.candles },
      [...closesBySymbol]
        .filter(([sym]) => sym.endsWith(".TA"))
        .map(([symbol, closes]) => ({ symbol, closes }))
    );
    if (regime) log(`🧭 מצב שוק: ${regime.label} (ציון ${regime.score}, רוחב ${regime.breadthPct.toFixed(0)}%)`);
  }

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

  const indices = await analyzeWorldIndices(mode, onProgress);
  for (const index of indices) {
    try {
      const candles = await fetchCandles(index.symbol, historyDays);
      historicalForecasts.set(index.symbol, historicalForecast({ symbol: index.symbol, candles, asOf: generatedAt, events }));
    } catch (error) {
      log(`   היסטוריה חסרה למדד ${index.symbol}: ${(error as Error).message}`);
    }
  }

  // מחירים עדכניים לקרנות סל שאינן ב-Yahoo — מעמודי המכשיר ב-investing.com
  const invHoldings = PORTFOLIO.filter((h) => !h.symbol && h.investingUrl);
  if (invHoldings.length) {
    log(`💹 מושך מחירי קרנות סל מ-investing.com (${invHoldings.length} ניירות)...`);
    for (const h of invHoldings) {
      const price = await fetchInvestingPrice(h.investingUrl!);
      if (price != null) {
        extraPrices.set(h.name, price);
        log(`   ✅ ${h.name}: ${price.toLocaleString("he-IL")}`);
      } else {
        log(`   ⚠️  ${h.name}: לא התקבל מחיר מ-investing.com.`);
      }
      await sleep(400);
    }
  }

  // אימות צולב של מחירי ההחזקות מול מקור שני (investing.com אם הוגדר, אחרת אתר הבורסה)
  const priceChecks: PriceCheck[] = [];
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));
  for (const h of PORTFOLIO) {
    if (!h.symbol || (!h.taseNumber && !h.investingUrl)) continue;
    const r = bySymbol.get(h.symbol);
    if (!r) continue;
    const second = h.investingUrl
      ? await fetchInvestingPrice(h.investingUrl)
      : await fetchTasePrice(h.taseNumber!);
    if (second == null) continue;
    const deviationPct = ((r.price - second) / second) * 100;
    priceChecks.push({ symbol: h.symbol, name: h.name, yahoo: r.price, tase: second, deviationPct });
    if (Math.abs(deviationPct) > PRICE_DEVIATION_WARN_PCT) {
      log(`   ⚠️  ${h.name}: פער מחיר ${deviationPct.toFixed(1)}% מול המקור השני (${second.toLocaleString("he-IL")}).`);
    }
    await sleep(300);
  }

  const sparkCloses = new Map<string, number[]>();
  for (const h of PORTFOLIO) {
    if (!h.symbol) continue;
    const closes = closesBySymbol.get(h.symbol);
    if (closes) sparkCloses.set(h.symbol, closes.slice(-60));
  }

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
    historicalForecasts,
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
  };
}
