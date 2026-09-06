/**
 * הפקת דוח HTML מעוצב עם טבלת המלצות מדורגת ופירוט אותות לכל מניה,
 * ובניית עמוד index.html עם סרגל צד וניווט יומי/שבועי.
 */
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AnalysisResult, HorizonInfo } from "./analysis.js";
import type { IndexAnalysis } from "./indices.js";
import type { StockNews, NewsItem } from "./news.js";
import type { MarketRegime } from "./regime.js";
import type { CorrPair } from "./risk.js";
import type { BetaEntry } from "./runner.js";
import { renderReportHtml, buildIndexHtml, type IndexReportEntry } from "./html.js";
import { generateForecast, type HistoricalForecast } from "./forecast.js";
import { selectDailyPick } from "./pick.js";
import { PORTFOLIO } from "./config.js";
import { DocumentStore, migrateLegacyStorage, pruneReportHtml, readHistory, type HistoryKey, type MigrationResult } from "./storage.js";

export type Mode = "daily" | "weekly";

export interface PriceCheckEntry {
  symbol: string;
  name: string;
  yahoo: number;
  tase: number;
  deviationPct: number;
}

/** רשומת המלצה יומית שנשמרת למעקב ביצועים. */
export interface PickRecord {
  symbol: string;
  name: string;
  price: number;
  combined: number;
  stop: number | null;
  target: number | null;
}

/** תוצאת המלצה קודמת מול המחיר הנוכחי. */
export interface PickOutcome extends PickRecord {
  date: string;
  currentPrice: number;
  returnPct: number;
  daysHeld: number;
  hitTarget: boolean;
  hitStop: boolean;
}

export interface PickScorecard {
  outcomes: PickOutcome[];
  count: number;
  winners: number;
  hitRate: number;
  avgReturn: number;
  best: PickOutcome | null;
  worst: PickOutcome | null;
}

/** שינוי באותות של החזקה מול הדוח הקודם. */
export interface SignalDelta {
  added: string[];
  removed: string[];
}

export interface ReportInput {
  mode: Mode;
  results: AnalysisResult[];
  indices: IndexAnalysis[];
  newsByStock: Map<string, StockNews>;
  allNews: NewsItem[];
  generatedAt: Date;
  /** מחיר אחרון לניירות שלא נותחו (היסטוריה קצרה) — למקטע התיק. */
  extraPrices?: Map<string, number>;
  /** אופקים נוספים (שבועי + ארוך) לדוח המשולב היומי. */
  horizons?: Map<string, HorizonInfo>;
  regime?: MarketRegime | null;
  correlations?: CorrPair[];
  betas?: BetaEntry[];
  priceChecks?: PriceCheckEntry[];
  /** מחירי סגירה אחרונים להחזקות — לגרפי מיני בדוח. */
  sparkCloses?: Map<string, number[]>;
  historicalForecasts?: Map<string, HistoricalForecast>;
}

export async function generateReport(input: ReportInput): Promise<string> {
  const {
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
  } = input;
  const forecast = generateForecast(mode, indices, allNews);

  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  const migration = migrateLegacyStorage(process.cwd());
  for (const error of migration.errors) console.warn(`Storage migration: ${error.file}: ${error.message}`);
  if (migration.errors.some((error) => dirname(error.file) === dir)) {
    throw new Error("History migration failed; original history and reports retained");
  }
  const { history, pickHistory, signalHistory } = loadHistories(dir);
  // תאריך לפי שעון ישראל — הרצה אחרי חצות UTC לא תדרוס את הדוח של אתמול
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(generatedAt);

  // ציוני הדוח הקודם — להצגת Δ (שינוי ציון) ליד כל מניה
  const modeHist = history[mode] ?? {};
  const prevDate = Object.keys(modeHist)
    .filter((d) => d < stamp)
    .sort()
    .at(-1);
  const prevScores = prevDate ? new Map(Object.entries(modeHist[prevDate])) : null;

  // כרטיס ציונים להמלצות קודמות — מודד את המנוע מול תוצאות בפועל
  const modePicks = pickHistory[mode] ?? {};
  const scorecard = buildScorecard(modePicks, stamp, results);

  // שינוי אותות מול הדוח הקודם (החזקות בלבד — לשמירת גודל הקובץ)
  const modeSignals = signalHistory[mode] ?? {};
  const prevSignalDate = Object.keys(modeSignals)
    .filter((d) => d < stamp)
    .sort()
    .at(-1);
  const signalDeltas = buildSignalDeltas(
    prevSignalDate ? modeSignals[prevSignalDate] : null,
    results
  );

  const html = renderReportHtml({
    mode,
    results,
    indices,
    newsByStock,
    forecast,
    generatedAt,
    prevScores,
    extraPrices,
    horizons,
    regime,
    correlations,
    betas,
    priceChecks,
    sparkCloses,
    scorecard,
    signalDeltas,
    historicalForecasts,
  });

  // כתיבה לקובץ HTML
  const fileName = `report-${mode}-${stamp}.html`;
  const filePath = join(dir, fileName);
  await writeFile(filePath, html, "utf8");

  // עדכון היסטוריית הציונים (שומרים עד 60 תאריכים אחרונים לכל מצב)
  modeHist[stamp] = Object.fromEntries(results.map((r) => [r.symbol, r.score]));

  // רישום ההמלצה של היום למעקב ביצועים בדוחות הבאים
  const pick = selectDailyPick(results, horizons, regime);
  if (pick.main) {
    modePicks[stamp] = {
      symbol: pick.main.r.symbol,
      name: pick.main.r.name,
      price: pick.main.r.price,
      combined: pick.main.hz.combined,
      stop: pick.main.r.risk?.stop ?? null,
      target: pick.main.r.risk?.target ?? null,
    };
  }

  // שמירת אותות ההחזקות להשוואה בדוח הבא
  const heldSymbols = new Set(PORTFOLIO.map((h) => h.symbol).filter((s): s is string => !!s));
  modeSignals[stamp] = Object.fromEntries(
    results.filter((r) => heldSymbols.has(r.symbol)).map((r) => [r.symbol, r.signals])
  );
  const store = new DocumentStore(join(dir, "state.sqlite"));
  try {
    store.transaction(() => {
      saveHistoryDate(store, "score-history", mode, stamp, modeHist[stamp], 60);
      if (pick.main) saveHistoryDate(store, "pick-history", mode, stamp, modePicks[stamp], 120);
      saveHistoryDate(store, "signal-history", mode, stamp, modeSignals[stamp], 10);
    });
    await archiveReports(dir, store, true);
  } finally { store.close(); }

  return filePath;
}

/** mode -> date (YYYY-MM-DD) -> symbol -> score */
type ScoreHistory = Partial<Record<Mode, Record<string, Record<string, number>>>>;
/** mode -> date -> ההמלצה שניתנה באותו יום */
type PickHistory = Partial<Record<Mode, Record<string, PickRecord>>>;
/** mode -> date -> symbol -> אותות */
type SignalHistory = Partial<Record<Mode, Record<string, Record<string, string[]>>>>;

export async function maintainReportStorage(root = process.cwd()): Promise<MigrationResult & { archived: number }> {
  const migration = migrateLegacyStorage(root);
  const dir = join(root, "reports");
  const store = new DocumentStore(join(dir, "state.sqlite"));
  let archived: number;
  try { archived = await archiveReports(dir, store); }
  finally { store.close(); }
  return { ...migration, archived };
}

async function archiveReports(dir: string, store: DocumentStore, rebuildWhenUnchanged = false): Promise<number> {
  let archived: number;
  try { archived = pruneReportHtml(dir, store); }
  catch (error) {
    await rebuildIndex(dir);
    throw error;
  }
  if (archived > 0 || rebuildWhenUnchanged) await rebuildIndex(dir);
  return archived;
}

function loadHistories(dir: string): { history: ScoreHistory; pickHistory: PickHistory; signalHistory: SignalHistory } {
  const store = new DocumentStore(join(dir, "state.sqlite"));
  try {
    return store.transaction(() => ({
      history: readHistory<ScoreHistory>(store, "score-history"),
      pickHistory: readHistory<PickHistory>(store, "pick-history"),
      signalHistory: readHistory<SignalHistory>(store, "signal-history"),
    }));
  } finally { store.close(); }
}

function saveHistoryDate<T>(store: DocumentStore, key: HistoryKey, mode: Mode, stamp: string, value: T, limit: number): void {
  const current = readHistory<Partial<Record<Mode, Record<string, T>>>>(store, key);
  current[mode] = keepLast({ ...current[mode], [stamp]: value }, limit);
  store.set(key, current);
}

function keepLast<T>(byDate: Record<string, T>, n: number): Record<string, T> {
  const keys = Object.keys(byDate).sort().slice(-n);
  return Object.fromEntries(keys.map((d) => [d, byDate[d]]));
}

/** מודד את ביצועי ההמלצות הקודמות מול המחיר הנוכחי — כרטיס ציונים למנוע. */
function buildScorecard(
  picks: Record<string, PickRecord>,
  today: string,
  results: AnalysisResult[]
): PickScorecard {
  const priceBySymbol = new Map(results.map((r) => [r.symbol, r.price]));
  const outcomes: PickOutcome[] = [];
  for (const [date, p] of Object.entries(picks)) {
    if (date >= today) continue;
    const currentPrice = priceBySymbol.get(p.symbol);
    if (currentPrice == null || !(p.price > 0)) continue;
    outcomes.push({
      ...p,
      date,
      currentPrice,
      returnPct: ((currentPrice - p.price) / p.price) * 100,
      daysHeld: Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000),
      hitTarget: p.target != null && currentPrice >= p.target,
      hitStop: p.stop != null && currentPrice <= p.stop,
    });
  }
  outcomes.sort((a, b) => b.date.localeCompare(a.date));
  const recent = outcomes.slice(0, 20);
  const winners = recent.filter((o) => o.returnPct > 0).length;
  const sorted = [...recent].sort((a, b) => b.returnPct - a.returnPct);
  return {
    outcomes: recent,
    count: recent.length,
    winners,
    hitRate: recent.length ? (winners / recent.length) * 100 : 0,
    avgReturn: recent.length ? recent.reduce((s, o) => s + o.returnPct, 0) / recent.length : 0,
    best: sorted[0] ?? null,
    worst: sorted.at(-1) ?? null,
  };
}

/** משווה את אותות ההחזקות לדוח הקודם ומחזיר מה נוסף ומה נעלם. */
function buildSignalDeltas(
  prev: Record<string, string[]> | null,
  results: AnalysisResult[]
): Map<string, SignalDelta> {
  const out = new Map<string, SignalDelta>();
  if (!prev) return out;
  // מנרמלים מספרים כדי ששינוי ערך בלבד לא ייחשב "אות חדש"
  const norm = (s: string) => s.replace(/[\d.,%()\-]+/g, "").trim();
  for (const r of results) {
    const before = prev[r.symbol];
    if (!before) continue;
    const beforeSet = new Set(before.map(norm));
    const afterSet = new Set(r.signals.map(norm));
    const added = r.signals.filter((s) => !beforeSet.has(norm(s)));
    const removed = before.filter((s) => !afterSet.has(norm(s)));
    if (added.length || removed.length) out.set(r.symbol, { added, removed });
  }
  return out;
}

/** סורק את תיקיית הדוחות ובונה מחדש את index.html בתיקייה הראשית. */
async function rebuildIndex(dir: string): Promise<void> {
  const files = await readdir(dir);
  const entries: IndexReportEntry[] = [];
  const re = /^report-(daily|weekly)-(\d{4}-\d{2}-\d{2})\.html$/;
  for (const f of files) {
    const m = re.exec(f);
    if (m)
      entries.push({ mode: m[1] as Mode, date: m[2], file: `reports/${f}` });
  }
  const indexHtml = buildIndexHtml(entries);
  await writeFile(join(dirname(dir), "index.html"), indexHtml, "utf8");
}
