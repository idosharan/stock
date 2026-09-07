import { loadInstrumentConfig } from "./instruments.js";

const instrumentConfig = loadInstrumentConfig();

/**
 * הגדרות האייג'נט: רשימת מניות למעקב, מקורות חדשות, ופרמטרים לניתוח.
 * ניתן לערוך את הרשימות בהתאם לתיק ההשקעות / תחומי העניין.
 */

export interface StockDef {
  /** סימול ב-Yahoo Finance (מניות ת"א מסתיימות ב-.TA) */
  symbol: string;
  /** שם תצוגה בעברית */
  name: string;
}

/**
 * מניות גדולות/מובילות בבורסת ת"א (מדד ת"א-125 + ת"א-SME).
 * הסימולים בפורמט Yahoo Finance עם סיומת .TA. הרשימה נוקתה
 * מסימולים כפולים וממניות שאינן נסחרות/הוסבו ב-Yahoo. הקוד מדלג על
 * כשלים בחן. ניתן לערוך את הרשימה לפי הצורך.
 */
export const WATCHLIST: StockDef[] = instrumentConfig.watchlist;

/** מקורות RSS של עיתונות כלכלית/כללית בישראל לסריקת כתבות. */
export const NEWS_FEEDS: { name: string; url: string }[] = [
  { name: "גלובס - שוק ההון", url: "https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=2" },
  { name: "כלכליסט", url: "https://www.calcalist.co.il/GeneralRSS/0,16335,L-8,00.xml" },
  { name: "TheMarker - שוק ההון", url: "https://www.themarker.com/cmlink/1.145" },
  { name: "ynet כלכלה", url: "https://www.ynet.co.il/Integration/StoryRss6.xml" },
];

/**
 * עקיפת אימות תעודת TLS — נדרש בסביבות עם פרוקסי ארגוני המבצע
 * הצפנה/פענוח (self-signed certificate in chain). ברירת המחדל מאובטחת (false);
 * שכבת הרשת מזהה כשל תעודה ועוברת אוטומטית למצב מקל עם אזהרה, וניתן לכפות
 * מראש עם ALLOW_INSECURE_TLS=1. הפתרון הנקי: NODE_EXTRA_CA_CERTS עם תעודת הפרוקסי.
 */
export const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === "1";

/** משתנה סביבה מספרי — מתעלם מערך ריק (GitHub Actions מעביר "" למשתנה שלא הוגדר). */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** ניהול סיכון וגודל פוזיציה — בסיס לחישוב כמות המניות בכל המלצה. */
export const RISK = {
  /** הון התיק לצורך חישוב גודל פוזיציה (₪). */
  capital: envNumber("PORTFOLIO_CAPITAL", 100_000),
  /** אחוז ההון שמסתכנים בו בעסקה בודדת. */
  riskPerTradePct: 1,
  /** יחס סיכוי/סיכון מינימלי להמלצת קנייה. */
  minRR: 1.5,
};

/** מדדי ייחוס לחישוב חוזק יחסי, בטא ומצב שוק. */
export const BENCHMARKS = {
  /** מניות ת"א — ת"א 125 עם נפילה חזרה לת"א 35 אם אינו זמין. */
  israel: { symbol: "TA125.TA", fallback: "TA35.TA", name: "ת\"א 125" },
  /** מניות חו"ל. */
  world: { symbol: "^GSPC", fallback: "^IXIC", name: "S&P 500" },
};

/** קאש נרות מקומי — מקצר הרצות ומפחית חסימות קצב. */
export const CANDLE_CACHE = {
  enabled: process.env.CANDLE_CACHE !== "0",
  /** תוקף בדקות — הרצה חוזרת בהמשך היום תמשוך נתונים טריים. */
  ttlMinutes: envNumber("CANDLE_CACHE_TTL_MIN", 45),
};

/** החזקה בתיק האישי — להצגת מצב התיק בדוח. */
export interface HoldingDef {
  /** סימול Yahoo אם הנייר מנותח ב-WATCHLIST (מניות). */
  symbol?: string;
  name: string;
  /** מחיר כניסה (אג' למניות ת"א / $ לניירות חו"ל / מחיר קרן). */
  entryPrice: number;
  note?: string;
  /** קרנות שאינן ב-Yahoo — מדד ייחוס למעקב טריגרים (ממוצעים קצר/ארוך). */
  triggerIndex?: string;
  /** רמת בקרה — התראה בדוח אם המחיר יורד מתחתיה. */
  alertBelow?: number;
  /** עמוד המכשיר ב-investing.com — למשיכת מחיר אחרון לקרנות סל שאינן ב-Yahoo. */
  investingUrl?: string;
  /** מספר נייר בבורסת ת"א — לאימות צולב של המחיר מול אתר הבורסה. */
  taseNumber?: string;
}

export const PORTFOLIO: HoldingDef[] = instrumentConfig.portfolio;

/** סקטורים שהתיק כבר חשוף אליהם (ישירות ודרך קרנות ממונפות) — לאיתות חפיפה בהמלצת היום. */
export const STOCK_SECTORS: Record<string, string> = instrumentConfig.stockSectors;

/** הסקטורים המוחזקים בתיק (כולל חשיפה דרך פי 3 ת"א 35 לבנקים ופי 3 NDX לטק). */
export const HELD_SECTORS = Array.from(new Set(instrumentConfig.portfolio.flatMap(holding => holding.sector ? [holding.sector] : holding.symbol ? [STOCK_SECTORS[holding.symbol]].filter(Boolean) : [])));

/** פרמטרים לניתוח טכני. */
export const PARAMS = {
  /** טווח היסטוריה למשיכה (ימים). */
  historyDays: 200,
  /** טווח היסטוריה למצב שבועי (ימים) — דרוש כדי שיהיו מספיק נרות שבועיים לממוצע הארוך. */
  historyDaysWeekly: 730,
  /** תקופת ממוצע נע קצר. */
  smaShort: 5,
  /** תקופת ממוצע נע ארוך. */
  smaLong: 13,
  /** תקופת RSI. */
  rsiPeriod: 14,
  /** תקופת רצועות בולינגר. */
  bbPeriod: 10,
  /** מספר סטיות תקן לרצועות בולינגר. */
  bbStdDev: 2,
  /** MACD. */
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  /** סף RSI למצב מכירת יתר (איתות קנייה פוטנציאלי). */
  rsiOversold: 35,
  /** סף RSI למצב קניית יתר (אזהרה). */
  rsiOverbought: 70,
  /** אוסצילטור סטוכסטי. */
  stochPeriod: 14,
  stochSmoothK: 3,
  stochSmoothD: 3,
  stochOversold: 20,
  stochOverbought: 80,
  /** Williams %R. */
  williamsPeriod: 14,
  /** ATR — לחישוב תנודתיות. */
  atrPeriod: 14,
  /** ADX — עוצמת מגמה. */
  adxPeriod: 14,
  /** סף ADX למגמה חזקה. */
  adxStrong: 25,
  /** CCI — Commodity Channel Index. */
  cciPeriod: 20,
  cciOversold: -100,
  cciOverbought: 100,
  /** MFI — Money Flow Index (RSI משוקלל נפח). */
  mfiPeriod: 14,
  mfiOversold: 20,
  mfiOverbought: 80,
  /** ROC — Rate of Change (מומנטום). */
  rocPeriod: 12,
  /** VWAP מתגלגל. */
  vwapPeriod: 20,
  /** Supertrend — קו מגמה מבוסס ATR. */
  supertrendPeriod: 10,
  supertrendMult: 3,
  /** ערוץ Donchian לזיהוי פריצות. */
  donchianPeriod: 20,
  /** תקופת חישוב חוזק יחסי מול מדד הייחוס (ימי מסחר). */
  rsPeriod: 60,
  /** Chandelier Exit — סטופ נגרר. */
  chandelierPeriod: 22,
  chandelierMult: 3,
  /** התראה על דוחות כספיים בטווח הימים הקרוב. */
  earningsWarnDays: 5,
};

/**
 * מדדי מניות מובילים בעולם — ארה"ב, ישראל, אירופה (DAX), אסיה.
 * משמשים לסקירת שווקים גלובלית והמלצות מגמה. הסימולים בפורמט Yahoo Finance.
 */
export interface IndexDef {
  symbol: string;
  name: string;
  region: "ארה\"ב" | "ישראל" | "אירופה" | "אסיה";
}

export const WORLD_INDICES: IndexDef[] = [
  // ארה"ב
  { symbol: "^GSPC", name: "S&P 500", region: "ארה\"ב" },
  { symbol: "^DJI", name: "Dow Jones", region: "ארה\"ב" },
  { symbol: "^IXIC", name: "Nasdaq Composite", region: "ארה\"ב" },
  { symbol: "^NDX", name: "Nasdaq 100", region: "ארה\"ב" },
  { symbol: "^RUT", name: "Russell 2000", region: "ארה\"ב" },
  { symbol: "^VIX", name: "VIX (מדד הפחד)", region: "ארה\"ב" },
  // ישראל
  { symbol: "TA35.TA", name: "ת\"א 35", region: "ישראל" },
  { symbol: "TA90.TA", name: "ת\"א 90", region: "ישראל" },
  { symbol: "207.TA", name: "ת\"א ביטחוניות", region: "ישראל" },
  // אירופה
  { symbol: "^GDAXI", name: "DAX (גרמניה)", region: "אירופה" },
  { symbol: "^FTSE", name: "FTSE 100 (בריטניה)", region: "אירופה" },
  { symbol: "^FCHI", name: "CAC 40 (צרפת)", region: "אירופה" },
  { symbol: "^STOXX50E", name: "Euro Stoxx 50", region: "אירופה" },
  // אסיה
  { symbol: "^N225", name: "Nikkei 225 (יפן)", region: "אסיה" },
  { symbol: "^HSI", name: "Hang Seng (הונג קונג)", region: "אסיה" },
  { symbol: "000001.SS", name: "Shanghai Composite (סין)", region: "אסיה" },
  { symbol: "^KS11", name: "KOSPI (קוריאה)", region: "אסיה" },
];
