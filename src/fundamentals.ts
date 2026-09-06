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
}

const CACHE_DIR = path.resolve(".cache");
const CACHE_FILE = path.join(CACHE_DIR, "fundamentals.json");

interface CacheShape {
  date: string;
  data: Record<string, Fundamentals | null>;
}

let memCache: CacheShape | null = null;

const todayKey = (): string => new Date().toISOString().slice(0, 10);

async function loadCache(): Promise<CacheShape> {
  if (memCache) return memCache;
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8")) as CacheShape;
    memCache = parsed.date === todayKey() ? parsed : { date: todayKey(), data: {} };
  } catch {
    memCache = { date: todayKey(), data: {} };
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
    ]);
    const r = json?.quoteSummary?.result?.[0];
    if (r) {
      const sd = r.summaryDetail ?? {};
      const ks = r.defaultKeyStatistics ?? {};
      const fd = r.financialData ?? {};
      const ce = r.calendarEvents ?? {};
      // מועד הדוחות הקרוב מגיע כמערך של חותמות זמן (לפעמים טווח משוער)
      const earningsTs: number | null = (() => {
        const arr = ce?.earnings?.earningsDate;
        const first = Array.isArray(arr) ? raw(arr[0]) : null;
        return first;
      })();
      // מניות ת"א: מחיר באגורות מול נתונים למניה בש"ח → מכפילים מנופחים פי 100
      const norm100 = (v: number | null): number | null =>
        v != null && symbol.endsWith(".TA") && v > 200 ? v / 100 : v;
      let pb = raw(ks.priceToBook);
      if (pb != null && symbol.endsWith(".TA") && pb > 50) pb = pb / 100;
      if (pb != null && (pb <= 0 || pb > 50)) pb = null;
      f = {
        trailingPE: norm100(raw(sd.trailingPE) ?? raw(ks.trailingPE)),
        forwardPE: norm100(raw(sd.forwardPE) ?? raw(ks.forwardPE)),
        priceToBook: pb,
        dividendYield: raw(sd.dividendYield),
        earningsGrowth: raw(fd.earningsGrowth) ?? raw(ks.earningsQuarterlyGrowth),
        revenueGrowth: raw(fd.revenueGrowth),
        profitMargins: raw(fd.profitMargins) ?? raw(ks.profitMargins),
        debtToEquity: raw(fd.debtToEquity),
        returnOnEquity: raw(fd.returnOnEquity),
        earningsDate: earningsTs != null ? new Date(earningsTs * 1000).toISOString() : null,
      };
      if (!Object.values(f).some((v) => v != null)) f = null;
    }
  } catch (err) {
    // כשל רשת/פרסינג — לא נשמר בקאש כדי שלא יאבדו הנתונים לשאר היום
    console.warn(`   ⚠️  פונדמנטלס ${symbol}: ${(err as Error).message}`);
    return null;
  }
  cache.data[symbol] = f;
  await saveCache();
  return f;
}
