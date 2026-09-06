/**
 * Backtest ל-walk-forward: לכל יום מסחר בחלון הבדיקה מחושב ציון האייג'נט
 * רק מהנתונים שהיו זמינים עד אותו יום, ונמדדת התשואה קדימה.
 * חדשות ופונדמנטלס לא זמינים היסטורית — נבדק הרכיב הטכני בלבד.
 *
 * הרצה:
 *   npm run backtest                          -> 250 ימי בדיקה, צעד 2, עד 20 ניירות, עלות 20 bps
 *   npm run backtest -- --days=120 --step=5 --limit=20 --horizons=5,10,20 --cost-bps=0
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALLOW_INSECURE_TLS, WATCHLIST, PARAMS, BENCHMARKS } from "./config.js";
import { analyzeStock, type Recommendation } from "./analysis.js";
import type { Candle } from "./data.js";
import { validateHistoricalForecast, type HistoricalValidation } from "./forecast.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- פרמטרים ----------------------------- */

export interface BacktestOptions {
  days: number;
  step: number;
  limit: number;
  horizons: number[];
  costBps: number;
}

export function parseBacktestOptions(args: string[]): BacktestOptions {
  const options: BacktestOptions = { days: 250, step: 2, limit: 20, horizons: [5, 10, 20], costBps: 20 };
  for (const argument of args) {
    const match = /^--(days|step|limit|horizons|cost-bps)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Invalid option ${argument}; expected --name=value`);
    const [, name, raw] = match;
    const values = raw.split(",");
    const numbers = values.map(Number);
    const valid = values.every(value => value.trim() !== "") && numbers.every(value =>
      name === "cost-bps" ? Number.isFinite(value) && value >= 0 : Number.isSafeInteger(value) && value > 0);
    if (!valid || (name !== "horizons" && values.length !== 1)) throw new Error(`Invalid --${name}: ${raw}`);
    if (name === "horizons") options.horizons = [...new Set(numbers)];
    else if (name === "cost-bps") options.costBps = numbers[0];
    else options[name as "days" | "step" | "limit"] = numbers[0];
  }
  return options;
}

export function forwardNetReturn(candles: Candle[], index: number, horizon: number, costBps = 20): number | null {
  if (!Number.isFinite(costBps) || costBps < 0) throw new Error("costBps must be finite and non-negative");
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(horizon) || horizon < 1) return null;
  const entry = candles[index + 1]?.open;
  const exit = candles[index + horizon]?.close;
  if (!(entry > 0) || !(exit > 0) || !Number.isFinite(entry) || !Number.isFinite(exit)) return null;
  const net = (exit / entry - 1) * 100 - costBps / 100;
  return Number.isFinite(net) ? net : null;
}

export function aggregateHistoricalValidation(symbols: HistoricalValidation[][]): HistoricalValidation[] {
  const rows = symbols.flat();
  return [...new Set(rows.map(row => row.days))].sort((left, right) => left - right).map(days => {
    const group = rows.filter(row => row.days === days);
    const total = (key: "tested" | "estimated" | "selectedCount") => group.reduce((sum, row) => sum + row[key], 0);
    const estimated = total("estimated");
    const selectedCount = total("selectedCount");
    const weighted = (key: "brier" | "baselineBrier" | "meanReturn" | "selectedReturn", weight: "estimated" | "selectedCount") => {
      const count = total(weight);
      if (!count || group.some(row => row[weight] > 0 && (row[key] === null || !Number.isFinite(row[key])))) return null;
      return group.reduce((sum, row) => sum + (row[key] ?? 0) * row[weight], 0) / count;
    };
    const buckets = group.flatMap(row => row.calibration);
    return {
      days, tested: total("tested"), estimated, selectedCount,
      brier: weighted("brier", "estimated"), baselineBrier: weighted("baselineBrier", "estimated"),
      meanReturn: weighted("meanReturn", "estimated"), selectedReturn: weighted("selectedReturn", "selectedCount"),
      calibration: [...new Set(buckets.map(bucket => bucket.band))].sort().map(band => {
        const members = buckets.filter(bucket => bucket.band === band);
        const count = members.reduce((sum, bucket) => sum + bucket.count, 0);
        const average = (key: "predicted" | "observed") => !count || members.some(bucket => bucket.count > 0 && bucket[key] === null)
          ? null : members.reduce((sum, bucket) => sum + (bucket[key] ?? 0) * bucket.count, 0) / count;
        return { band, count, predicted: average("predicted"), observed: average("observed") };
      }),
    };
  });
}

const HORIZONS = [5, 10, 20];
const WARMUP = PARAMS.smaLong + 70; // נרות מינימליים לפני הציון הראשון

/* ----------------------------- איסוף תצפיות ----------------------------- */

export interface Observation {
  symbol: string;
  name: string;
  date: string; // תאריך הציון (ISO)
  score: number;
  recommendation: Recommendation;
  /** האותות שנדלקו באותה נקודה — למדידת האדג' של כל אות בנפרד. */
  signals: string[];
  /** תשואה קדימה באחוזים לכל אופק. */
  fwd: Record<number, number | null>;
}

const EMPTY_NEWS = { items: [], totalSentiment: 0, freshNegative: [] };

export interface SymbolValidation {
  symbol: string;
  name: string;
  benchmark: string | null;
  candleCount: number;
  validation: HistoricalValidation[];
  error: string | null;
}

export interface BacktestRun {
  observations: Observation[];
  historical: SymbolValidation[];
}

interface CollectionDependencies {
  fetchCandles: (symbol: string, days: number) => Promise<Candle[]>;
  universe?: Array<{ symbol: string; name: string }>;
  log?: (message: string) => void;
  pause?: (milliseconds: number) => Promise<void>;
}

export function alignBenchmarkCloses(history: Candle[], benchmark: Candle[], period = PARAMS.rsPeriod): number[] | undefined {
  if (history.length <= period) return undefined;
  const asOf = history.at(-1)!.date;
  const byDate = new Map(benchmark.filter(candle => candle.date <= asOf && Number.isFinite(candle.close) && candle.close > 0)
    .map(candle => [candle.date.toISOString().slice(0, 10), candle.close]));
  const closes = history.slice(-period - 1).map(candle => byDate.get(candle.date.toISOString().slice(0, 10)));
  return closes.every((close): close is number => close !== undefined) ? closes : undefined;
}

export async function collectBacktest(options: BacktestOptions, dependencies: CollectionDependencies): Promise<BacktestRun> {
  const { days, step, limit, horizons, costBps } = options;
  const log = dependencies.log ?? console.log;
  const pause = dependencies.pause ?? sleep;
  const maxHorizon = Math.max(...horizons);
  const calendarDays = Math.max(730, Math.ceil((days + WARMUP + Math.max(maxHorizon, 20)) * 1.45) + 30);
  const seen = new Set<string>();
  const universe = (dependencies.universe ?? WATCHLIST).filter(stock => !seen.has(stock.symbol) && !!seen.add(stock.symbol)).slice(0, limit);
  const observations: Observation[] = [];
  const historical: SymbolValidation[] = [];
  const requests = new Map<string, Promise<Candle[]>>();
  const fetchOnce = (symbol: string) => {
    if (!requests.has(symbol)) requests.set(symbol, dependencies.fetchCandles(symbol, calendarDays));
    return requests.get(symbol)!;
  };
  const fetchBenchmark = async (definition: typeof BENCHMARKS.israel) => {
    for (const symbol of [definition.symbol, definition.fallback]) {
      try {
        const candles = await fetchOnce(symbol);
        if (candles.length > 60) return { symbol, candles };
        log(`מדד ייחוס ${symbol}: אין מספיק נרות; מנסה חלופה.`);
      } catch (error) {
        log(`מדד ייחוס ${symbol}: ${(error as Error).message}`);
      }
    }
    return null;
  };
  const israel = await fetchBenchmark(BENCHMARKS.israel);
  const world = await fetchBenchmark(BENCHMARKS.world);

  log(`Backtest: ${universe.length} מניות · חלון ${days} ימי מסחר · צעד ${step} · אופקים ${horizons.join("/")} · עלות ${costBps} bps`);

  let done = 0;
  for (const stock of universe) {
    const benchmark = stock.symbol.endsWith(".TA") ? israel : world;
    const record: SymbolValidation = { symbol: stock.symbol, name: stock.name, benchmark: benchmark?.symbol ?? null,
      candleCount: 0, validation: [], error: null };
    historical.push(record);
    try {
      const candles = await fetchOnce(stock.symbol);
      record.candleCount = candles.length;
      record.validation = validateHistoricalForecast({ symbol: stock.symbol, candles, benchmark: benchmark?.candles, costBps }, days);
      const startIdx = Math.max(WARMUP, candles.length - days - maxHorizon);
      const endIdx = candles.length - 1 - maxHorizon;

      let count = 0;
      for (let index = startIdx; index <= endIdx; index += step) {
        const history = candles.slice(0, index + 1);
        const benchmarkCloses = benchmark ? alignBenchmarkCloses(history, benchmark.candles) : undefined;
        const res = analyzeStock(
          stock.symbol,
          stock.name,
          history,
          { symbol: stock.symbol },
          EMPTY_NEWS,
          undefined,
          benchmarkCloses ? { benchmarkCloses, benchmarkName: benchmark!.symbol } : undefined
        );
        if (!res) continue;
        const fwd: Record<number, number | null> = {};
        for (const horizon of horizons) fwd[horizon] = forwardNetReturn(candles, index, horizon, costBps);
        if (horizons.every(horizon => fwd[horizon] === null)) continue;
        observations.push({
          symbol: stock.symbol,
          name: stock.name,
          date: candles[index].date.toISOString().slice(0, 10),
          score: res.score,
          recommendation: res.recommendation,
          signals: res.signals,
          fwd,
        });
        count++;
      }
      done++;
      log(`   ${stock.name} (${stock.symbol}): ${count} תצפיות [${done}/${universe.length}]`);
    } catch (err) {
      done++;
      record.error = (err as Error).message;
      log(`   ${stock.name} (${stock.symbol}): ${record.error}`);
    }
    await pause(250);
  }
  return { observations, historical };
}

/* ----------------------------- סטטיסטיקה ----------------------------- */

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // דירוג ממוצע לשוברי שוויון
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

const spearman = (xs: number[], ys: number[]): number => pearson(ranks(xs), ranks(ys));

/* ----------------------------- דוח ----------------------------- */

interface BucketStats {
  rec: Recommendation;
  count: number;
  perHorizon: Record<number, { avg: number; med: number; winRate: number }>;
}

const REC_ORDER: Recommendation[] = ["קנייה חזקה", "קנייה", "החזקה", "הימנעות / מכירה"];

export function summarize(obs: Observation[], horizons = HORIZONS) {
  const buckets: BucketStats[] = REC_ORDER.map((rec) => {
    const group = obs.filter((o) => o.recommendation === rec);
    const perHorizon: BucketStats["perHorizon"] = {};
    for (const h of horizons) {
      const rets = group.map((o) => o.fwd[h]).filter((r): r is number => r != null);
      perHorizon[h] = {
        avg: mean(rets),
        med: median(rets),
        winRate: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : NaN,
      };
    }
    return { rec, count: group.length, perHorizon };
  });

  // בנצ'מרק: ממוצע כלל התצפיות (יקום שווה-משקל)
  const benchmark: Record<number, number> = {};
  for (const h of horizons) {
    benchmark[h] = mean(obs.map((o) => o.fwd[h]).filter((r): r is number => r != null));
  }

  // IC: ספירמן חתך-רוחבי לכל תאריך, ממוצע על התאריכים
  const icPerHorizon: Record<number, { ic: number; dates: number }> = {};
  const byDate = new Map<string, Observation[]>();
  for (const o of obs) {
    (byDate.get(o.date) ?? byDate.set(o.date, []).get(o.date)!).push(o);
  }
  for (const h of horizons) {
    const ics: number[] = [];
    for (const group of byDate.values()) {
      const valid = group.filter((o) => o.fwd[h] != null);
      if (valid.length < 8) continue;
      const ic = spearman(valid.map((o) => o.score), valid.map((o) => o.fwd[h] as number));
      if (isFinite(ic)) ics.push(ic);
    }
    icPerHorizon[h] = { ic: mean(ics), dates: ics.length };
  }

  // פער עשירונים: עשירון ציון עליון מול תחתון
  const decileSpread: Record<number, number> = {};
  for (const h of horizons) {
    const valid = obs.filter((o) => o.fwd[h] != null).sort((a, b) => a.score - b.score);
    const n = Math.floor(valid.length / 10);
    if (n >= 5) {
      const bottom = mean(valid.slice(0, n).map((o) => o.fwd[h] as number));
      const top = mean(valid.slice(-n).map((o) => o.fwd[h] as number));
      decileSpread[h] = top - bottom;
    } else {
      decileSpread[h] = NaN;
    }
  }

  return { buckets, benchmark, icPerHorizon, decileSpread, scoreBuckets: scoreBuckets(obs, horizons), signalEdges: signalEdges(obs, horizons[Math.min(1, horizons.length - 1)]) };
}

/* ------------------- אבחון תיאורי: דליי ציון ופילוח אותות ------------------- */

const SCORE_BANDS: Array<[number, number, string]> = [
  [-Infinity, 0, "שלילי (<0)"],
  [0, 20, "0–20"],
  [20, 40, "20–40"],
  [40, 60, "40–60"],
  [60, Infinity, "60+"],
];

interface ScoreBucket {
  label: string;
  count: number;
  perHorizon: Record<number, { avg: number; winRate: number }>;
}

/** האם ציון גבוה באמת מניב יותר? פילוח התשואות לפי דלי ציון. */
function scoreBuckets(obs: Observation[], horizons: number[]): ScoreBucket[] {
  return SCORE_BANDS.map(([lo, hi, label]) => {
    const group = obs.filter((o) => o.score >= lo && o.score < hi);
    const perHorizon: ScoreBucket["perHorizon"] = {};
    for (const h of horizons) {
      const rets = group.map((o) => o.fwd[h]).filter((r): r is number => r != null);
      perHorizon[h] = {
        avg: mean(rets),
        winRate: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : NaN,
      };
    }
    return { label, count: group.length, perHorizon };
  });
}

interface SignalEdge {
  signal: string;
  count: number;
  avg: number;
  winRate: number;
  /** תשואה עודפת מול כלל התצפיות באותו אופק. */
  excess: number;
}

/** מסיר מספרים/סוגריים כדי לאחד ניסוחים של אותו אות. */
const normalizeSignal = (s: string): string =>
  s
    .replace(/\([^)]*\)/g, "")
    .replace(/[\d.,%]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/** מודד לכל אות בנפרד את התשואה הממוצעת קדימה — אילו אותות באמת עובדים. */
function signalEdges(obs: Observation[], horizon = HORIZONS[Math.min(1, HORIZONS.length - 1)]): SignalEdge[] {
  const all = obs.map((o) => o.fwd[horizon]).filter((r): r is number => r != null);
  const base = mean(all);
  const groups = new Map<string, number[]>();
  for (const o of obs) {
    const ret = o.fwd[horizon];
    if (ret == null) continue;
    for (const key of new Set(o.signals.map(normalizeSignal))) {
      if (!key) continue;
      const arr = groups.get(key) ?? [];
      arr.push(ret);
      groups.set(key, arr);
    }
  }
  const out: SignalEdge[] = [];
  for (const [signal, rets] of groups) {
    if (rets.length < 30) continue;
    const avg = mean(rets);
    out.push({
      signal,
      count: rets.length,
      avg,
      winRate: (rets.filter((r) => r > 0).length / rets.length) * 100,
      excess: avg - base,
    });
  }
  return out.sort((a, b) => b.excess - a.excess);
}

const fmt = (n: number, digits = 2): string => (isFinite(n) ? n.toFixed(digits) : "-");
const fmtPct = (n: number, digits = 2): string => (isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%` : "-");
const nullableNumber = (value: number | null, digits = 4) => value === null ? "-" : fmt(value, digits);
const nullableReturn = (value: number | null) => value === null ? "-" : fmtPct(value);
const probability = (value: number | null) => value === null ? "-" : `${fmt(value * 100, 1)}%`;

function methodology(options: BacktestOptions): string[] {
  return [
    `ביצוע: ציון בסגירת t, כניסה בפתיחת t+1, יציאה בסגירת t+h; עלות הלוך ושוב ${options.costBps} נקודות בסיס (${fmt(options.costBps / 100)}%). התשואות נטו, ללא חיתוך זנבות.`,
    `יקום נוכחי: עד ${options.limit} הניירות הראשונים ברשימת המעקב כיום (ברירת מחדל 20), לא היקום שהיה זמין בכל מועד. קיימות הטיות בחירה ושרידות; ניירות שנכשלו או ללא אומדן מפורטים בכיסוי.`,
    `האבחון הטכני נדגם כל ${options.step} ימי מסחר ועשוי לכלול עסקאות חופפות. הוא תיאורי בלבד, אינו כיול הסתברויות, ולא נלמדים ממנו ספים או משקולות.`,
    'אימות התחזיות באופקי 5/10/20 ימים משתמש ב-validateHistoricalForecast: דגימה לא חופפת לכל נייר ואופק במרווח h+1. תכונות זמינות רק עד מועד התחזית ותוצאות אנלוגים מסתיימות לפניו (embargo קפדני); אין שימוש בתוצאות עתידיות לאימון.',
    'כיסוי: tested הם מועדי בדיקה; estimated הם מועדים עם אומדן ובסיס זמינים. Brier ו-baseline Brier: נמוך יותר עדיף, על אותם מועדים. Brier ותשואת ALL eligible משוקללים לפי estimated; תשואת הנבחרות לפי selectedCount; דליים לפי מספר המקרים.',
    'ALL eligible כולל את כל התצפיות עם אומדן זמין, גם אלה שלא נבחרו, ולא את מועדי ההימנעות. נבחרות p>=0.6 הן תת-קבוצה בהרכב ובמועדים שונים; הפער בתשואה אינו השוואה מזווגת, הוכחת יתרון או ביצועי תיק. קיימת תלות בין ניירות ואופקים.',
    'דליי הסתברות מציגים הסתברות חזויה, שיעור חיובי בפועל ומספר מקרים. אלה בדיקות אמינות ניסיוניות, לא טענה שההסתברויות מכוילות; לא נלמדות משקולות.',
    'מדדי ייחוס: BENCHMARKS.israel לניירות .TA ו-BENCHMARKS.world לאחרים, עם חלופה מוגדרת. התחזית מקבלת Candle[] מתוארכים; באבחון הטכני חוזק יחסי מושמט כאשר אין התאמה מלאה לתאריכי חלון המדידה.',
    'קורפוס אירועים היסטורי לא הוערך (historical event corpus not evaluated). חדשות, פונדמנטלס, בחירת הנייר היומית והאסטרטגיה הרב-אופקית החיה אינם נבדקים כאן.',
    'נתוני הספק אינם תשואה כוללת מאומתת: דיבידנדים, פעולות הון, נרות חלקיים ושגיאות מחיר עלולים להשפיע. עלות קבועה אינה מדמה נזילות, השפעת שוק, מסים או מגבלות ביצוע; נתבקשו לפחות 730 ימים קלנדריים, אך היסטוריה זמינה עלולה להיות קצרה יותר. ביצועי עבר אינם ערובה לעתיד.',
  ];
}

export function formatHistoricalConsole(symbols: SymbolValidation[]): string {
  const lines = [`אימות תחזיות היסטוריות | ניירות: ${symbols.length} | שגיאות: ${symbols.filter(symbol => symbol.error).length}`];
  const append = (label: string, rows: HistoricalValidation[]) => {
    for (const row of rows) {
      lines.push(`${label} h=${row.days} | estimated=${row.estimated} / tested=${row.tested} | coverage=${row.tested ? probability(row.estimated / row.tested) : "-"} | Brier=${nullableNumber(row.brier)} | baseline Brier=${nullableNumber(row.baselineBrier)} (lower is better) | ALL eligible=${nullableReturn(row.meanReturn)} | selected=${nullableReturn(row.selectedReturn)} (p>=0.6, n=${row.selectedCount})`);
      for (const bucket of row.calibration) {
        lines.push(`  ${bucket.band} | n=${bucket.count} | predicted=${probability(bucket.predicted)} | actual=${probability(bucket.observed)} | expected positive=${bucket.predicted === null ? "-" : fmt(bucket.predicted * bucket.count)} | actual positive=${bucket.observed === null ? "-" : fmt(bucket.observed * bucket.count, 0)}`);
      }
    }
  };
  append("TOTAL", aggregateHistoricalValidation(symbols.map(symbol => symbol.validation)));
  for (const symbol of symbols) {
    lines.push(`${symbol.symbol} (${symbol.name}) | candles=${symbol.candleCount} | benchmark=${symbol.benchmark ?? "missing"}${symbol.error ? ` | error=${symbol.error}` : ""}`);
    if (!symbol.validation.length) lines.push("  No validation observations available");
    append(symbol.symbol, symbol.validation);
  }
  return lines.join("\n");
}

function printConsole(obs: Observation[], s: ReturnType<typeof summarize>, options: BacktestOptions) {
  console.log(`\n📊 סה"כ ${obs.length} תצפיות מ-${new Set(obs.map((o) => o.symbol)).size} מניות\n`);
  for (const h of options.horizons) {
    console.log(`אופק ${h} ימי מסחר (ממוצע כלל התצפיות, לא מדד: ${fmtPct(s.benchmark[h])})`);
    for (const b of s.buckets) {
      const p = b.perHorizon[h];
      console.log(
        `   ${b.rec.padEnd(16)} | n=${String(b.count).padStart(5)} | ממוצע ${fmtPct(p.avg)} | חציון ${fmtPct(
          p.med
        )} | פגיעה ${fmt(p.winRate, 0)}%`
      );
    }
    console.log(
      `   IC (ספירמן ממוצע, ${s.icPerHorizon[h].dates} תאריכים): ${fmt(s.icPerHorizon[h].ic, 3)} | פער עשירונים: ${fmtPct(
        s.decileSpread[h]
      )}`
    );
    console.log("");
  }

  console.log("פילוח ציונים תיאורי; לא כיול ולא אימון משקולות");
  const calH = options.horizons[Math.min(1, options.horizons.length - 1)];
  for (const b of s.scoreBuckets) {
    const p = b.perHorizon[calH];
    console.log(
      `   ציון ${b.label.padEnd(12)} | n=${String(b.count).padStart(5)} | ממוצע ${fmtPct(p.avg)} | פגיעה ${fmt(p.winRate, 0)}% (אופק ${calH})`
    );
  }

  console.log("\nאותות עם הפרש התשואה הגבוה/נמוך במדגם (אבחון חקרני):");
  for (const e of s.signalEdges.slice(0, 5)) {
    console.log(`   ➕ ${e.signal.padEnd(45)} n=${String(e.count).padStart(5)} עודף ${fmtPct(e.excess)}`);
  }
  for (const e of s.signalEdges.slice(-5).reverse()) {
    console.log(`   ➖ ${e.signal.padEnd(45)} n=${String(e.count).padStart(5)} עודף ${fmtPct(e.excess)}`);
  }
  console.log("");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function historicalHtml(symbols: SymbolValidation[]): string {
  const totals = aggregateHistoricalValidation(symbols.map(symbol => symbol.validation));
  const headings = '<tr><th>נייר</th><th>אופק</th><th>tested</th><th>estimated</th><th>כיסוי</th><th>Brier</th><th>baseline Brier</th><th>ALL eligible נטו</th><th>נבחרות נטו p&gt;=0.6</th><th>selectedCount</th></tr>';
  const rows = (label: string, validation: HistoricalValidation[]) => validation.map(row => `<tr>
    <th scope="row">${esc(label)}</th><td class="num">${row.days}</td><td class="num">${row.tested}</td>
    <td class="num">${row.estimated}</td><td class="num">${row.tested ? probability(row.estimated / row.tested) : "-"}</td>
    <td class="num">${nullableNumber(row.brier)}</td><td class="num">${nullableNumber(row.baselineBrier)}</td>
    <td class="num">${nullableReturn(row.meanReturn)}</td><td class="num">${nullableReturn(row.selectedReturn)}</td><td class="num">${row.selectedCount}</td></tr>`).join("");
  const groups = [{ label: "סה״כ משוקלל", validation: totals }, ...symbols.map(symbol => ({ label: symbol.symbol, validation: symbol.validation }))];
  const calibrationRows = groups.flatMap(group => group.validation.flatMap(row => row.calibration.map(bucket => `<tr>
    <th scope="row">${esc(group.label)}</th><td class="num">${row.days}</td><td class="num">${esc(bucket.band)}</td>
    <td class="num">${bucket.count}</td><td class="num">${probability(bucket.predicted)}</td><td class="num">${probability(bucket.observed)}</td>
    <td class="num">${bucket.predicted === null ? "-" : fmt(bucket.predicted * bucket.count)}</td>
    <td class="num">${bucket.observed === null ? "-" : fmt(bucket.observed * bucket.count, 0)}</td></tr>`))).join("");
  return `<section>
    <h2>אימות תחזיות היסטוריות</h2>
    <p class="meta">Brier ו-baseline Brier: נמוך יותר עדיף. אומדנים חסרים אינם אפס. האיגוד משוקלל לפי מספר התצפיות הרלוונטיות.</p>
    <table><caption>סיכום משוקלל</caption><thead>${headings}</thead><tbody>${rows("סה״כ", totals) || '<tr><td colspan="10">אין תצפיות אימות</td></tr>'}</tbody></table>
    <h3>כיסוי ותוצאות לכל נייר</h3>
    <p class="meta">${symbols.length} ניירות ביקום שנבחר; ${symbols.filter(symbol => symbol.error).length} עם שגיאה.</p>
    <table><thead>${headings}</thead><tbody>${symbols.map(symbol => rows(`${symbol.name} (${symbol.symbol})`, symbol.validation) || `<tr><th scope="row">${esc(symbol.name)} (${esc(symbol.symbol)})</th><td colspan="9">אין תצפיות אימות</td></tr>`).join("")}</tbody></table>
    <table><caption>זמינות נתונים ומדד ייחוס</caption><thead><tr><th>נייר</th><th>נרות</th><th>מדד ייחוס</th><th>סטטוס</th></tr></thead>
      <tbody>${symbols.map(symbol => `<tr><th scope="row">${esc(symbol.symbol)}</th><td class="num">${symbol.candleCount}</td><td>${esc(symbol.benchmark ?? "חסר")}</td><td>${esc(symbol.error ?? "הנתונים נטענו; זמינות אומדנים בטבלת הכיסוי")}</td></tr>`).join("")}</tbody></table>
    <p class="note">ALL eligible כולל את כל המועדים עם אומדן זמין, לא רק נבחרות. p&gt;=0.6 היא תת-קבוצה שונה בהרכב ובמועדים; זו אינה השוואה מזווגת או הוכחת יתרון.</p>
  </section>
  <section><h2>דליי הסתברות: חזוי מול בפועל</h2>
    <p class="meta">תוצאה חיובית = תשואה נטו גדולה מאפס. מספר חיוביים חזוי הוא סכום ההסתברויות. אלה מדדי אמינות ניסיוניים, לא הסתברויות שהוכחו כמכוילות.</p>
    <table><thead><tr><th>נייר</th><th>אופק</th><th>דלי</th><th>מקרים</th><th>חזוי</th><th>בפועל</th><th>חיוביים חזויים</th><th>חיוביים בפועל</th></tr></thead><tbody>${calibrationRows || '<tr><td colspan="8">אין אומדנים זמינים</td></tr>'}</tbody></table>
  </section>`;
}

export function buildHtml(obs: Observation[], s: ReturnType<typeof summarize>, generatedAt: Date, options: BacktestOptions, historical: SymbolValidation[] = []): string {
  const horizonSections = options.horizons.map((h) => {
    const rows = s.buckets
      .map((b) => {
        const p = b.perHorizon[h];
        const excess = p.avg - s.benchmark[h];
        return `<tr>
          <td>${esc(b.rec)}</td>
          <td class="num">${b.count}</td>
          <td class="num ${p.avg >= 0 ? "up" : "down"}">${fmtPct(p.avg)}</td>
          <td class="num">${fmtPct(p.med)}</td>
          <td class="num">${fmt(p.winRate, 0)}%</td>
          <td class="num ${excess >= 0 ? "up" : "down"}">${fmtPct(excess)}</td>
        </tr>`;
      })
      .join("\n");
    return `<section>
      <h2>אופק ${h} ימי מסחר</h2>
      <p class="meta">ממוצע כלל התצפיות (לא מדד ייחוס ולא תיק שווה-משקל): <strong>${fmtPct(s.benchmark[h])}</strong> ·
        IC ספירמן ממוצע: <strong>${fmt(s.icPerHorizon[h].ic, 3)}</strong> (${s.icPerHorizon[h].dates} תאריכים) ·
        פער עשירון עליון-תחתון: <strong>${fmtPct(s.decileSpread[h])}</strong></p>
      <table>
        <thead><tr><th>המלצה</th><th>תצפיות</th><th>תשואה נטו ממוצעת</th><th>חציון</th><th>אחוז חיוביות</th><th>הפרש מול כלל התצפיות</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join("\n");

  const calH = options.horizons[Math.min(1, options.horizons.length - 1)];
  const scoreRows = s.scoreBuckets
    .map(
      (b) => `<tr>
        <td>${esc(b.label)}</td>
        <td class="num">${b.count}</td>
        <td class="num ${b.perHorizon[calH].avg >= 0 ? "up" : "down"}">${fmtPct(b.perHorizon[calH].avg)}</td>
        <td class="num">${fmt(b.perHorizon[calH].winRate, 0)}%</td>
      </tr>`
    )
    .join("\n");

  const edgeRow = (e: (typeof s.signalEdges)[number]) => `<tr>
      <td>${esc(e.signal)}</td>
      <td class="num">${e.count}</td>
      <td class="num ${e.avg >= 0 ? "up" : "down"}">${fmtPct(e.avg)}</td>
      <td class="num">${fmt(e.winRate, 0)}%</td>
      <td class="num ${e.excess >= 0 ? "up" : "down"}">${fmtPct(e.excess)}</td>
    </tr>`;
  const bestEdges = s.signalEdges.slice(0, 12).map(edgeRow).join("\n");
  const worstEdges = s.signalEdges.slice(-12).reverse().map(edgeRow).join("\n");

  const calibrationSection = `<section>
    <h2>פילוח ציונים תיאורי (אופק ${calH} ימים)</h2>
    <p class="meta">תשואות לפי דלי ציון במדגם הנוכחי; אין כיול הסתברויות או למידת ספים ומשקולות.</p>
    <table>
      <thead><tr><th>דלי ציון</th><th>תצפיות</th><th>תשואה ממוצעת</th><th>אחוז פגיעה</th></tr></thead>
      <tbody>${scoreRows}</tbody>
    </table>
  </section>
  <section>
    <h2>פילוח אותות חקרני (אופק ${calH} ימים)</h2>
    <p class="meta">הפרש מול ממוצע כלל התצפיות לאותות עם 30 הופעות ומעלה. ריבוי בדיקות, תלות וחפיפה מונעים הסקת יתרון מוכח; לא נלמדות משקולות.</p>
    <h3>הפרשים גבוהים במדגם</h3>
    <table>
      <thead><tr><th>אות</th><th>הופעות</th><th>תשואה ממוצעת</th><th>אחוז פגיעה</th><th>עודף</th></tr></thead>
      <tbody>${bestEdges}</tbody>
    </table>
    <h3>הפרשים נמוכים במדגם</h3>
    <table>
      <thead><tr><th>אות</th><th>הופעות</th><th>תשואה ממוצעת</th><th>אחוז פגיעה</th><th>עודף</th></tr></thead>
      <tbody>${worstEdges}</tbody>
    </table>
  </section>`;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>דוח Backtest — ${generatedAt.toLocaleDateString("he-IL")}</title>
<style>
:root{--paper:#f4f8f7;--ink:#263331;--teal:#087e80;--line:#cedcda;--muted:#526764;--negative:#a53847}
*{box-sizing:border-box;letter-spacing:0}
body{margin:0;font-family:"Assistant","Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.65}
.report{max-width:1200px;min-width:0;margin:0 auto;padding:28px}
.report-header{border-top:5px solid var(--teal);border-bottom:1px solid var(--line);padding:24px 0}
h1{margin:0 0 8px;font-size:28px;line-height:1.3;overflow-wrap:anywhere}
.report-header p{margin:0;font-size:14px;color:var(--muted)}
section{padding:24px 0;border-bottom:1px solid var(--line);min-width:0}
h2{font-size:21px;margin:0 0 12px;color:var(--teal)}h3{font-size:17px;margin:20px 0 10px}
.meta{color:var(--muted);font-size:14px;margin:0 0 14px;overflow-wrap:anywhere}
.table-scroll{max-width:100%;overflow-x:auto;margin:12px 0;border:1px solid var(--line);border-radius:4px}
.table-scroll:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
table{width:100%;min-width:650px;border-collapse:collapse;font-size:14px;background:#fff}
caption{text-align:right;padding:10px;font-weight:600;background:#e5f1ee;color:var(--ink)}
thead th{background:#e5f1ee;padding:10px;text-align:right;border-bottom:2px solid var(--line)}
tbody td,tbody th{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;overflow-wrap:anywhere}
tbody th{font-weight:500}tbody tr:nth-child(even){background:#f7faf9}
.num{text-align:left;direction:ltr;font-variant-numeric:tabular-nums;white-space:nowrap}
.up{color:#087154;font-weight:600}.down{color:var(--negative);font-weight:600}
.note{border-right:3px solid var(--teal);padding:8px 14px;font-size:14px;margin:16px 0;overflow-wrap:anywhere}
.methodology{padding-right:22px;font-size:14px}.methodology li{margin:8px 0;overflow-wrap:anywhere}
@media(max-width:640px){.report{padding:14px}h1{font-size:23px}h2{font-size:19px}.report-header{padding:18px 0}section{padding:20px 0}}
@media print{@page{size:A4 landscape;margin:12mm}body{background:#fff;color:#000}.report{max-width:none;padding:0}.report-header{padding:8px 0}section{padding:12px 0}.table-scroll{overflow:visible;border-radius:0}table{min-width:0;table-layout:fixed;font-size:10px}th,td{padding:4px!important;overflow-wrap:anywhere}.num{white-space:normal}thead{display:table-header-group}tr{break-inside:avoid}h2,h3{break-after:avoid}.meta,.note,.methodology{font-size:11px}.up,.down{color:#000}}
</style>
</head>
<body>
<main class="report">
  <header class="report-header">
    <h1>Backtest: אבחון טכני ואימות תחזיות</h1>
    <p>${obs.length.toLocaleString()} תצפיות · ${new Set(obs.map((o) => o.symbol)).size} מניות · חלון ${options.days} ימי מסחר · צעד ${options.step} · נוצר ${generatedAt.toLocaleString("he-IL")}</p>
  </header>
  <section><h2>שיטת הבדיקה ומגבלותיה</h2><ul class="methodology">${methodology(options).map(note => `<li>${esc(note)}</li>`).join("")}</ul></section>
  ${historicalHtml(historical)}
  ${horizonSections}
  ${calibrationSection}
</main>
</body>
</html>`.replace(/<table>/g, '<div class="table-scroll" tabindex="0" role="region" aria-label="טבלת תוצאות"><table>').replace(/<\/table>/g, '</table></div>');
}

/* ----------------------------- main ----------------------------- */

export async function main(args = process.argv.slice(2), dependencies?: CollectionDependencies) {
  const options = parseBacktestOptions(args);
  if (!dependencies) {
    if (ALLOW_INSECURE_TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const { fetchCandles } = await import("./data.js");
    dependencies = { fetchCandles };
  }
  const generatedAt = new Date();
  const { observations: obs, historical } = await collectBacktest(options, dependencies);
  console.log(methodology(options).join("\n"));
  console.log(formatHistoricalConsole(historical));
  if (!obs.length) {
    console.error("לא נאספו תצפיות — בדוק חיבור/סימולים.");
    process.exitCode = 1;
    return;
  }
  const s = summarize(obs, options.horizons);
  printConsole(obs, s, options);

  const outDir = path.resolve("reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `backtest-${generatedAt.toISOString().slice(0, 10)}.html`);
  await writeFile(outPath, buildHtml(obs, s, generatedAt, options, historical), "utf8");
  console.log(`📄 דוח Backtest נשמר: ${outPath}`);
  const { maintainReportStorage } = await import("./report.js");
  await maintainReportStorage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("שגיאה קריטית ב-Backtest:", err);
    process.exitCode = 1;
  });
}
