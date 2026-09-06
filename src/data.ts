/**
 * שכבת משיכת נתונים: מושכת נרות יומיים (OHLCV) ישירות מנקודת הקצה הציבורית
 * של נתוני המסחר (chart JSON), ללא ספריות חיצוניות. מטפלת בעוגייה + crumb
 * הנדרשים לאימות, עם מנגנון ניסיונות חוזרים (backoff) למגבלת קצב.
 *
 * הערה: מקורות ישראליים רבים (אתר הבורסה, גלובס, Stooq) חוסמים גישה אוטומטית
 * או דורשים JavaScript, ולכן נקודת קצה זו היא המקור היציב ביותר מאחורי פרוקסי ארגוני.
 */
import path from "node:path";
import { ALLOW_INSECURE_TLS, CANDLE_CACHE } from "./config.js";
import { DocumentStore, migrateLegacyStorage, readCachedCandles, type CandleCacheDocument } from "./storage.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CHART_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

/* ----------------------- TLS מול פרוקסי ארגוני ----------------------- */

let tlsRelaxed = ALLOW_INSECURE_TLS;
if (ALLOW_INSECURE_TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const CERT_ERRORS = [
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

function isCertError(err: unknown): boolean {
  const parts = [
    (err as { code?: string })?.code,
    ((err as { cause?: { code?: string } })?.cause)?.code,
    (err as Error)?.message,
    ((err as { cause?: { message?: string } })?.cause)?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return CERT_ERRORS.some((c) => parts.includes(c));
}

/**
 * fetch עם נפילה מבוקרת למצב TLS מקל: האימות נשאר דלוק כברירת מחדל,
 * ורק כשמתקבלת שגיאת תעודה (פרוקסי ארגוני) עוברים למצב מקל עם אזהרה חד-פעמית.
 */
async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!tlsRelaxed && isCertError(err)) {
      tlsRelaxed = true;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      console.warn(
        "   ⚠️  אימות תעודת TLS נכשל (כנראה פרוקסי ארגוני) — ממשיך ללא אימות תעודה. " +
          "לפתרון קבוע הגדר NODE_EXTRA_CA_CERTS עם תעודת הפרוקסי."
      );
      return await fetch(url, init);
    }
    throw err;
  }
}

/** בדיקת קישוריות ותעודות לפני שאר הבקשות (נקראת בתחילת הריצה). */
export async function ensureTls(): Promise<void> {
  try {
    await httpFetch(`${CHART_HOSTS[0]}/v1/test/getcrumb`, { headers: { "User-Agent": UA } });
  } catch {
    /* כשל רשת רגיל — יטופל בבקשות עצמן */
  }
}

export interface Candle {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface QuoteInfo {
  symbol: string;
  currency?: string;
  regularMarketPrice?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------- ניהול עוגייה + crumb ----------------------- */

let cachedCookie: string | null = null;
let cachedCrumb: string | null = null;

/** מאתחל עוגייה ו-crumb (נשמרים בזיכרון לכל ההרצה), עם ניסיונות חוזרים ו-backoff. */
async function ensureSession(): Promise<{ cookie: string; crumb: string }> {
  if (cachedCrumb != null) {
    return { cookie: cachedCookie ?? "", crumb: cachedCrumb };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(1500 * Math.pow(2, attempt - 1)); // 1.5s..12s

    // 1. השגת עוגייה (A1/A3).
    let cookie = "";
    try {
      const res = await httpFetch("https://fc.yahoo.com", {
        headers: { "User-Agent": UA },
        redirect: "manual",
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
    } catch (err) {
      console.warn(`   ⚠️  כשל בהשגת עוגייה: ${(err as Error).message} — ממשיך ללא עוגייה.`);
    }

    // 2. השגת crumb.
    try {
      const host = CHART_HOSTS[attempt % CHART_HOSTS.length];
      const crumbRes = await httpFetch(`${host}/v1/test/getcrumb`, {
        headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
      });
      const crumb = (await crumbRes.text()).trim();
      if (!crumb || crumb.includes("<")) {
        lastErr = new Error("כשל בהשגת crumb לאימות מול שרת הנתונים.");
        continue;
      }
      cachedCookie = cookie;
      cachedCrumb = crumb;
      return { cookie, crumb };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("כשל בהשגת crumb לאימות מול שרת הנתונים.");
}

async function fetchChartJson(symbol: string, days: number): Promise<any> {
  const { cookie, crumb } = await ensureSession();
  const range =
    days <= 30
      ? "1mo"
      : days <= 95
      ? "3mo"
      : days <= 190
      ? "6mo"
      : days <= 370
      ? "1y"
      : days <= 740
      ? "2y"
      : "5y";

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = CHART_HOSTS[attempt % CHART_HOSTS.length];
    const useCrumb = cachedCrumb ?? crumb;
    const useCookie = cachedCookie ?? cookie;
    const url =
      `${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=${range}&crumb=${encodeURIComponent(useCrumb)}`;
    try {
      const res = await httpFetch(url, {
        headers: { "User-Agent": UA, ...(useCookie ? { Cookie: useCookie } : {}) },
      });
      if (res.status === 401 || res.status === 403) {
        // crumb/עוגייה פגו — איפוס וניסיון מחדש
        cachedCookie = null;
        cachedCrumb = null;
        await sleep(800 * (attempt + 1));
        await ensureSession();
        continue;
      }
      if (res.status === 429) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("כשל לא ידוע במשיכת נתונים");
}

/**
 * מושך מחיר אחרון מעמוד מכשיר ב-investing.com — לקרנות סל ישראליות שאינן
 * זמינות ב-Yahoo (איתור לפי מספר נייר בחיפוש investing → עמוד ה-ETF).
 */
export async function fetchInvestingPrice(url: string): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    try {
      const res = await httpFetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/data-test="instrument-price-last"[^>]*>([\d.,]+)</);
      if (m) {
        const price = Number(m[1].replace(/,/g, ""));
        if (Number.isFinite(price) && price > 0) return price;
      }
    } catch {
      /* ניסיון נוסף */
    }
  }
  return null;
}

/** מושך quoteSummary (נתונים פונדמנטליים) עם אותו מנגנון session וניסיונות חוזרים. */
export async function fetchQuoteSummary(symbol: string, modules: string[]): Promise<any> {
  const { cookie, crumb } = await ensureSession();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = CHART_HOSTS[attempt % CHART_HOSTS.length];
    const useCrumb = cachedCrumb ?? crumb;
    const useCookie = cachedCookie ?? cookie;
    const url =
      `${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules.join(",")}&crumb=${encodeURIComponent(useCrumb)}`;
    try {
      const res = await httpFetch(url, {
        headers: { "User-Agent": UA, ...(useCookie ? { Cookie: useCookie } : {}) },
      });
      if (res.status === 401 || res.status === 403) {
        cachedCookie = null;
        cachedCrumb = null;
        await sleep(800 * (attempt + 1));
        await ensureSession();
        continue;
      }
      if (res.status === 429) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 404) return null; // אין נתונים פונדמנטליים לסימול
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("כשל לא ידוע במשיכת quoteSummary");
}

/* ----------------------- קאש נרות מקומי ----------------------- */

let migratedCacheRoot: string | undefined;

function openCandleStore(): DocumentStore {
  const root = process.cwd();
  if (migratedCacheRoot !== root) {
    const migration = migrateLegacyStorage(root);
    for (const error of migration.errors) console.warn(`Storage migration: ${error.file}: ${error.message}`);
    migratedCacheRoot = root;
  }
  return new DocumentStore(path.join(root, ".cache", "candles.sqlite"));
}

async function readCandleCache(symbol: string, days: number): Promise<Candle[] | null> {
  if (!CANDLE_CACHE.enabled) return null;
  try {
    const store = openCandleStore();
    let raw: CandleCacheDocument | null;
    try { raw = readCachedCandles(store, symbol, days, CANDLE_CACHE.ttlMinutes); }
    finally { store.close(); }
    if (!raw) return null;
    return raw.candles.map(([d, o, h, l, c, v]) => ({
      date: new Date(d),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
    }));
  } catch (error) {
    console.warn(`Candle cache read failed for ${symbol}: ${(error as Error).message}`);
    return null;
  }
}

async function writeCandleCache(symbol: string, days: number, candles: Candle[]): Promise<void> {
  if (!CANDLE_CACHE.enabled) return;
  try {
    const payload: CandleCacheDocument = {
      symbol,
      days,
      fetchedAt: Date.now(),
      candles: candles.map((c) => [
        c.date.toISOString(),
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
      ]),
    };
    const store = openCandleStore();
    try { store.set(`candle:${symbol}`, payload); }
    finally { store.close(); }
  } catch (error) {
    console.warn(`Candle cache write failed for ${symbol}: ${(error as Error).message}`);
  }
}

/** מושך היסטוריית נרות יומיים עבור סימול נתון (עם קאש מקומי קצר-טווח). */
export async function fetchCandles(symbol: string, days: number): Promise<Candle[]> {
  const cached = await readCandleCache(symbol, days);
  if (cached) return cached;
  const json = await fetchChartJson(symbol, days);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("מבנה תגובה לא צפוי מהשרת.");

  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    candles.push({
      date: new Date(ts[i] * 1000),
      open,
      high,
      low,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }

  // יהווה מחזיר לעיתים את בר היום האחרון עם ערכי null (פיגור עדכון בניירות ת"א) —
  // משלימים נר ממחיר השוק ב-meta כדי שהניתוח יכלול את יום המסחר האחרון.
  const meta = result.meta ?? {};
  const px: number | undefined = meta.regularMarketPrice;
  const t: number | undefined = meta.regularMarketTime;
  if (px != null && t != null) {
    const metaDate = new Date(t * 1000);
    const lastDate = candles.length ? candles[candles.length - 1].date : null;
    const sameDay =
      lastDate != null &&
      lastDate.toISOString().slice(0, 10) === metaDate.toISOString().slice(0, 10);
    if (sameDay) {
      // הבר קיים — מעדכנים סגירה למחיר העדכני ביותר
      const lastC = candles[candles.length - 1];
      lastC.close = px;
      if (px > lastC.high) lastC.high = px;
      if (px < lastC.low) lastC.low = px;
    } else if (lastDate == null || metaDate > lastDate) {
      candles.push({
        date: metaDate,
        open: meta.regularMarketOpen ?? px,
        high: meta.regularMarketDayHigh ?? px,
        low: meta.regularMarketDayLow ?? px,
        close: px,
        volume: meta.regularMarketVolume ?? 0,
      });
    }
  }
  await writeCandleCache(symbol, days, candles);
  return candles;
}

/**
 * מחיר אחרון מאתר הבורסה לניירות ערך בת"א לפי מספר נייר — מקור שני לאימות צולב.
 * הערה: נכון ל-2026 נקודות הקצה של mayaapi/api.tase מוגנות ב-Incapsula (403) ועמוד market.tase
 * הוא SPA ללא מחיר ב-HTML — לכן הפונקציה מחזירה לרוב null. האימות הפעיל מתבצע
 * מול investing.com עבור החזקות שהוגדר להן investingUrl.
 */
export async function fetchTasePrice(securityNumber: string): Promise<number | null> {
  const urls = [
    `https://mayaapi.tase.co.il/api/security/wsecuritydata?securityId=${securityNumber}&lang=he`,
    `https://market.tase.co.il/he/market_data/security/${securityNumber}/major_data`,
  ];
  for (const url of urls) {
    try {
      const res = await httpFetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/html;q=0.9,*/*;q=0.8",
          "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) continue;
      const text = await res.text();
      // מבנה JSON של mayaapi או ערכי שער בתוך עמוד ה-HTML
      const m =
        /"LastRate"\s*:\s*([\d.]+)/i.exec(text) ??
        /"BaseRate"\s*:\s*([\d.]+)/i.exec(text) ??
        /"lastRate"\s*:\s*([\d.]+)/i.exec(text);
      if (m) {
        const price = Number(m[1]);
        if (Number.isFinite(price) && price > 0) return price;
      }
    } catch {
      /* מקור משני בלבד — כשל אינו קריטי */
    }
  }
  return null;
}

/** מושך נתוני ציטוט בסיסיים (מתוך ה-meta של ה-chart). */
export async function fetchQuoteInfo(symbol: string): Promise<QuoteInfo> {
  try {
    const json = await fetchChartJson(symbol, 30);
    const meta = json?.chart?.result?.[0]?.meta;
    return {
      symbol,
      currency: meta?.currency,
      regularMarketPrice: meta?.regularMarketPrice,
    };
  } catch {
    return { symbol };
  }
}

/**
 * צובר נרות יומיים לנרות שבועיים (קיבוץ לפי שבוע קלנדרי — שני עד שישי).
 * פתיחה = פתיחת הנר הראשון בשבוע, סגירה = סגירת האחרון,
 * שיא/שפל = מקסימום/מינימום בשבוע, נפח = סכום הנפח.
 */
export function resampleWeekly(candles: Candle[]): Candle[] {
  if (!candles.length) return [];
  const weeks: Candle[] = [];
  let bucket: Candle[] = [];

  const weekKey = (d: Date): string => {
    // מפתח שבוע לפי יום שני המוביל (ISO-like): מזיז את התאריך ליום שני של אותו שבוע.
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (tmp.getUTCDay() + 6) % 7; // שני=0 ... ראשון=6
    tmp.setUTCDate(tmp.getUTCDate() - day);
    return tmp.toISOString().slice(0, 10);
  };

  const flush = () => {
    if (!bucket.length) return;
    const first = bucket[0];
    const lastC = bucket[bucket.length - 1];
    weeks.push({
      date: lastC.date,
      open: first.open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: lastC.close,
      volume: bucket.reduce((s, c) => s + c.volume, 0),
    });
  };

  let currentKey = weekKey(candles[0].date);
  for (const c of candles) {
    const key = weekKey(c.date);
    if (key !== currentKey) {
      flush();
      bucket = [];
      currentKey = key;
    }
    bucket.push(c);
  }
  flush();
  return weeks;
}

