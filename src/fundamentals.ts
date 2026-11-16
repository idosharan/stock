/**
 * נתונים פונדמנטליים: מכפילים, צמיחה, דיבידנד ומינוף — נמשכים מ-quoteSummary
 * (אותו מקור נתונים של הנרות), עם קאש יומי בקובץ כדי לחסוך בקשות רשת.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchQuoteSummary } from "./data.js";

export interface Fundamentals {
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  /** תשואת דיבידנד כשבר (0.03 = 3%). */
  dividendYield: number | null;
  /** צמיחת רווחים כשבר (0.15 = 15%). */
  earningsGrowth: number | null;
  revenueGrowth: number | null;
  profitMargins: number | null;
  /** חוב/הון באחוזים כפי שמוחזר מהמקור (150 = 150%). */
  debtToEquity: number | null;
  returnOnEquity: number | null;
  /** מועד דוחות קרוב (ISO) — לאזהרה לפני פתיחת פוזיציה. */
  earningsDate: string | null;
  returnOnAssets: number | null;
  grossMargins: number | null;
  freeCashflow: number | null;
  evToEbitda: number | null;
  /** שורט כשבר מהמניות הצפות (0.05 = 5%) — זמין בעיקר במניות ארה"ב. */
  shortPercentFloat: number | null;
  /** תחזית EPS לשנה (period 0y, אחרת +1y) — היום ולפני 30/90 יום, ליחסי רוויזיה בלבד. */
  epsCurrent: number | null;
  eps30dAgo: number | null;
  eps90dAgo: number | null;
  revisionsUp30: number | null;
  revisionsDown30: number | null;
  /** מספר האנליסטים מאחורי תחזית ה-EPS — במניות ת"א לעיתים אנליסט יחיד. */
  epsAnalysts: number | null;
  /** הפתעות רווח כשבר, מהישנה לחדשה (עד 4 רבעונים מ-15 החודשים האחרונים). */
  surprises: number[];
  /** תחזית EPS לשנה הבאה (period +1y) — רוויזיות בסגנון Zacks לשתי שנות הכספים. */
  epsNextCurrent?: number | null;
  epsNext30dAgo?: number | null;
  epsNext90dAgo?: number | null;
  /** חוכמת המונים: קונצנזוס אנליסטים, מחירי יעד, שינויי המלצות, מקורבים ומוסדיים. */
  crowd?: CrowdData | null;
}

export interface CrowdData {
  analysts: number | null;
  /** (strongBuy + buy) / all ratings this month, and three months ago. */
  buyPct: number | null;
  buyPct3m: number | null;
  targetMean: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  upgrades90: number;
  downgrades90: number;
  targetRaises90: number;
  targetCuts90: number;
  /** Insider purchase / sale transaction counts over the last 6 months (mostly US stocks). */
  insiderBuys: number | null;
  insiderSells: number | null;
  institutionsPct: number | null;
}

const CACHE_VERSION = 4;
const CACHE_DIR = path.resolve(".cache");
const CACHE_FILE = path.join(CACHE_DIR, "fundamentals.json");

interface CacheShape {
  version: number;
  date: string;
  data: Record<string, Fundamentals | null>;
}

let memCache: CacheShape | null = null;
let droppedValues = 0;

const todayKey = (): string => new Date().toISOString().slice(0, 10);

async function loadCache(): Promise<CacheShape> {
  if (memCache) return memCache;
  const fresh = { version: CACHE_VERSION, date: todayKey(), data: {} };
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8")) as CacheShape;
    memCache = parsed.version === CACHE_VERSION && parsed.date === todayKey() ? parsed : fresh;
  } catch {
    memCache = fresh;
  }
  return memCache;
}

async function saveCache(): Promise<void> {
  if (!memCache) return;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(memCache), "utf8");
}

const raw = (v: unknown): number | null => {
  const n = (v as { raw?: unknown } | null)?.raw;
  return typeof n === "number" && isFinite(n) ? n : null;
};

/** ערכים פונדמנטליים שנזרקו כחריגים בריצה הנוכחית (לשורת בריאות הנתונים). */
export function getDroppedFundamentals(): number {
  return droppedValues;
}

/** Yahoo returns some crowd modules as plain numbers and others as { raw }. */
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : raw(v);
  return n != null && Number.isFinite(n) ? n : null;
};

function parseCrowd(r: any, asOf: Date): CrowdData | null {
  const fd = r.financialData ?? {};
  const trend: any[] = Array.isArray(r.recommendationTrend?.trend) ? r.recommendationTrend.trend : [];
  const share = (period: string): { buy: number | null; total: number } => {
    const t = trend.find((x) => x?.period === period);
    const counts = ["strongBuy", "buy", "hold", "sell", "strongSell"].map((k) => Math.max(0, num(t?.[k]) ?? 0));
    const total = counts.reduce((s, x) => s + x, 0);
    return { buy: total > 0 ? (counts[0] + counts[1]) / total : null, total };
  };
  const now = share("0m");
  const since = asOf.getTime() / 1000 - 90 * 86_400;
  const changes: any[] = (Array.isArray(r.upgradeDowngradeHistory?.history) ? r.upgradeDowngradeHistory.history : [])
    .filter((h: any) => (num(h?.epochGradeDate) ?? 0) >= since);
  const target = (h: any, key: string): number => num(h?.[key]) ?? 0;
  const institutions = num(r.majorHoldersBreakdown?.institutionsPercentHeld);
  const crowd: CrowdData = {
    analysts: num(fd.numberOfAnalystOpinions) ?? (now.total > 0 ? now.total : null),
    buyPct: now.buy,
    buyPct3m: share("-3m").buy,
    targetMean: num(fd.targetMeanPrice),
    targetHigh: num(fd.targetHighPrice),
    targetLow: num(fd.targetLowPrice),
    upgrades90: changes.filter((h) => h?.action === "up").length,
    downgrades90: changes.filter((h) => h?.action === "down").length,
    targetRaises90: changes.filter((h) => target(h, "priorPriceTarget") > 0 && target(h, "currentPriceTarget") > target(h, "priorPriceTarget")).length,
    targetCuts90: changes.filter((h) => target(h, "priorPriceTarget") > 0 && target(h, "currentPriceTarget") > 0
      && target(h, "currentPriceTarget") < target(h, "priorPriceTarget")).length,
    insiderBuys: num(r.netSharePurchaseActivity?.buyInfoCount),
    insiderSells: num(r.netSharePurchaseActivity?.sellInfoCount),
    institutionsPct: institutions != null && institutions >= 0 && institutions <= 1.5 ? institutions : null,
  };
  const has = crowd.buyPct != null || crowd.targetMean != null || changes.length > 0 || crowd.insiderBuys != null || crowd.insiderSells != null;
  return has ? crowd : null;
}

/** פרסור טהור של תשובת quoteSummary עם גבולות סבירות; ערך חריג → null ונספר. */
export function parseFundamentals(r: any, symbol: string, asOf: Date = new Date()): { data: Fundamentals | null; dropped: number } {
  if (!r || typeof r !== "object") return { data: null, dropped: 0 };
  let dropped = 0;
  const bound = (v: number | null, min: number, max: number, inclusiveMin = true): number | null => {
    if (v == null) return null;
    if ((inclusiveMin ? v >= min : v > min) && v <= max) return v;
    dropped++;
    return null;
  };
  const sd = r.summaryDetail ?? {};
  const ks = r.defaultKeyStatistics ?? {};
  const fd = r.financialData ?? {};
  const ce = r.calendarEvents ?? {};
  // מועד הדוחות הקרוב מגיע כמערך של חותמות זמן (לפעמים טווח משוער)
  const arr = ce?.earnings?.earningsDate;
  const earningsTs = Array.isArray(arr) ? raw(arr[0]) : null;
  // מניות ת"א: מחיר באגורות מול נתונים למניה בש"ח → מכפילים מנופחים פי 100
  const norm100 = (v: number | null): number | null => (v != null && symbol.endsWith(".TA") && v > 200 ? v / 100 : v);
  let pb = raw(ks.priceToBook);
  if (pb != null && symbol.endsWith(".TA") && pb > 50) pb = pb / 100;
  const trend: any[] = Array.isArray(r.earningsTrend?.trend) ? r.earningsTrend.trend : [];
  const year = trend.find((t) => t?.period === "0y" && raw(t?.epsTrend?.current) != null)
    ?? trend.find((t) => t?.period === "+1y" && raw(t?.epsTrend?.current) != null);
  const nextYear = year?.period === "0y" ? trend.find((t) => t?.period === "+1y" && raw(t?.epsTrend?.current) != null) : undefined;
  const history: any[] = Array.isArray(r.earningsHistory?.history) ? r.earningsHistory.history : [];
  // Yahoo מחזיר לעיתים רבעונים מלפני שנים במניות ת"א — רק הפתעות מ-15 החודשים האחרונים
  const oldestQuarter = asOf.getTime() / 1000 - 456 * 86_400;
  const surprises = history
    .map((h) => ({ q: raw(h?.quarter), s: raw(h?.surprisePercent) }))
    .filter((h): h is { q: number; s: number } => h.q != null && h.q >= oldestQuarter && h.s != null)
    .sort((a, b) => a.q - b.q)
    .map((h) => bound(h.s, -5, 5))
    .filter((s): s is number => s != null)
    .slice(-4);
  const f: Fundamentals = {
    trailingPE: bound(norm100(raw(sd.trailingPE) ?? raw(ks.trailingPE)), 0, 300, false),
    forwardPE: bound(norm100(raw(sd.forwardPE) ?? raw(ks.forwardPE)), 0, 300, false),
    priceToBook: bound(pb, 0, 50, false),
    dividendYield: bound(raw(sd.dividendYield), 0, 0.25),
    earningsGrowth: bound(raw(fd.earningsGrowth) ?? raw(ks.earningsQuarterlyGrowth), -1, 10),
    revenueGrowth: bound(raw(fd.revenueGrowth), -1, 10),
    profitMargins: bound(raw(fd.profitMargins) ?? raw(ks.profitMargins), -1, 1),
    debtToEquity: bound(raw(fd.debtToEquity), 0, 2000),
    returnOnEquity: bound(raw(fd.returnOnEquity), -3, 3),
    earningsDate: earningsTs != null ? new Date(earningsTs * 1000).toISOString() : null,
    returnOnAssets: bound(raw(fd.returnOnAssets), -3, 3),
    grossMargins: bound(raw(fd.grossMargins), -1, 1),
    freeCashflow: raw(fd.freeCashflow),
    evToEbitda: bound(raw(ks.enterpriseToEbitda), 0, 200, false),
    shortPercentFloat: bound(raw(ks.shortPercentOfFloat), 0, 1),
    epsCurrent: raw(year?.epsTrend?.current),
    eps30dAgo: raw(year?.epsTrend?.["30daysAgo"]),
    eps90dAgo: raw(year?.epsTrend?.["90daysAgo"]),
    revisionsUp30: raw(year?.epsRevisions?.upLast30days),
    revisionsDown30: raw(year?.epsRevisions?.downLast30days),
    epsAnalysts: raw(year?.earningsEstimate?.numberOfAnalysts),
    surprises,
    epsNextCurrent: raw(nextYear?.epsTrend?.current),
    epsNext30dAgo: raw(nextYear?.epsTrend?.["30daysAgo"]),
    epsNext90dAgo: raw(nextYear?.epsTrend?.["90daysAgo"]),
    crowd: parseCrowd(r, asOf),
  };
  const hasData = Object.entries(f).some(([k, v]) => (k === "surprises" ? surprises.length > 0 : v != null));
  return { data: hasData ? f : null, dropped };
}

/** מושך נתונים פונדמנטליים עם קאש יומי; מחזיר null כשאין נתונים לסימול. */
export async function getFundamentals(symbol: string): Promise<Fundamentals | null> {
  const cache = await loadCache();
  if (symbol in cache.data) return cache.data[symbol];

  let f: Fundamentals | null = null;
  try {
    const json = await fetchQuoteSummary(symbol, [
      "summaryDetail",
      "defaultKeyStatistics",
      "financialData",
      "calendarEvents",
      "earningsTrend",
      "earningsHistory",
      "recommendationTrend",
      "upgradeDowngradeHistory",
      "netSharePurchaseActivity",
      "majorHoldersBreakdown",
    ]);
    const parsed = parseFundamentals(json?.quoteSummary?.result?.[0], symbol);
    f = parsed.data;
    droppedValues += parsed.dropped;
  } catch (err) {
    // כשל רשת/פרסינג — לא נשמר בקאש כדי שלא יאבדו הנתונים לשאר היום
    console.warn(`   ⚠️  פונדמנטלס ${symbol}: ${(err as Error).message}`);
    return null;
  }
  cache.data[symbol] = f;
  await saveCache();
  return f;
}
