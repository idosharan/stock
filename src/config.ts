import { loadInstrumentConfig } from "./instruments.js";
import type { GradeKey } from "./grades.js";

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
 * World/geopolitical feeds — feed only the geopolitical index, never stock news sentiment.
 * `topic` feeds are searches (Iran/Hormuz) that are geopolitical by construction: examples only, not the share.
 */
export const GEO_FEEDS: { name: string; url: string; topic: boolean }[] = [
  { name: "Google News (geo)", topic: true, url: "https://news.google.com/rss/search?q=Iran+OR+Hormuz+OR+Hezbollah+OR+Houthi+OR+Gaza+OR+Israel+strike&hl=en-US&gl=US&ceid=US:en" },
  { name: "Google News (עברית)", topic: true, url: "https://news.google.com/rss/search?q=%D7%90%D7%99%D7%A8%D7%90%D7%9F+OR+%D7%94%D7%95%D7%A8%D7%9E%D7%95%D7%96+OR+%D7%97%D7%99%D7%96%D7%91%D7%90%D7%9C%D7%9C%D7%94&hl=iw&gl=IL&ceid=IL:he" },
  { name: "Bing News", topic: true, url: "https://www.bing.com/news/search?q=Iran+Hormuz+Israel&format=rss" },
  { name: "BBC Middle East", topic: true, url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
  { name: "Times of Israel", topic: false, url: "https://www.timesofisrael.com/feed/" },
  { name: "Globes English", topic: false, url: "https://en.globes.co.il/WebService/Rss/RssFeeder.asmx/FeederNode?iID=1725" },
  { name: "CNBC World", topic: false, url: "https://www.cnbc.com/id/100727362/device/rss/rss.html" },
];

/** YouTube channels followed in every report (RSS, no login). */
export const FOLLOWED_CHANNELS: { name: string; channelId: string }[] = [
  { name: "מיכה סטוקס", channelId: "UCSxjNbPriyBh9RNl_QNSAtw" },
];

/** Names the creators use in Hebrew (or brand names) → Yahoo symbol, for mention matching. */
export const CREATOR_ALIASES: Record<string, string> = {
  "אנבידיה": "NVDA", "ספייס אקס": "SPCX", "SpaceX": "SPCX", "HP": "HPQ", "אינטל": "INTC", "גוגל": "GOOGL", "אלפבית": "GOOGL",
  "אמזון": "AMZN", "מייקרוסופט": "MSFT", "אפל": "AAPL", "מטא": "META", "טסלה": "TSLA", "פלנטיר": "PLTR", "אורקל": "ORCL",
  "ברודקום": "AVGO", "מייקרון": "MU", "אדובי": "ADBE", "ספוטיפיי": "SPOT", "האבספוט": "HUBS", "שופיפיי": "SHOP",
  "קלאודפלר": "NET", "פורטינט": "FTNT", "סרוויס נאו": "NOW", "נטפליקס": "NFLX", "בואינג": "BA", "מאסטרקארד": "MA",
  "אלי לילי": "LLY", "קטרפילר": "CAT", "אקסון מוביל": "XOM", "שברון": "CVX", "פייזר": "PFE", "רדיט": "RDDT",
  "סנדיסק": "SNDK", "קוואלקום": "QCOM", "אובר": "UBER", "נובו נורדיסק": "NVO", "מקדונלדס": "MCD",
  "קראודסטרייק": "CRWD", "פאלו אלטו": "PANW", "פלו אלטו": "PANW", "צ'ק פוינט": "CHKP", "זיסקיילר": "ZS", "רובריק": "RBRK",
  "נביוס": "NBIS", "סיסקו": "CSCO", "וולמארט": "WMT", "הום דיפו": "HD", "טרגט": "TGT", "דיסני": "DIS", "עליבאבא": "BABA",
};

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

/** מקביליות משיכת נתונים — יורדת אוטומטית ל-1 אחרי חסימת קצב (429). */
export const FETCH = {
  concurrency: envNumber("FETCH_CONCURRENCY", 3),
};

/**
 * ציוני ראיות שאושרו על ידי המשתמש להצטרף לדירוג אחרי שעברו בדיקה קדימה (npm run backtest).
 * ריק = הציונים מוצגים בלבד. ערכים אפשריים: momentum, revisions, surprise, quality, value, risk.
 */
export const GRADES_IN_RANKING: GradeKey[] = [];

/** החזקה בתיק האישי — להצגת מצב התיק בדוח. */
export interface HoldingDef {
  /** סימול Yahoo אם הנייר מנותח ב-WATCHLIST (מניות). */
  symbol?: string;
  name: string;
  /** מחיר כניסה (אג' למניות ת"א / $ לניירות חו"ל / מחיר קרן); חסר רק בהחזקת ליבה ללא עלות ידועה. */
  entryPrice?: number;
  /** החזקת ליבה קבועה — לעולם לא מקבלת המלצת יציאה/צמצום, רק "רמות לבחינה". */
  core?: boolean;
  note?: string;
  /** קרנות שאינן ב-Yahoo — מדד ייחוס למעקב טריגרים (ממוצעים קצר/ארוך). */
  triggerIndex?: string;
  /** רמת בקרה — התראה בדוח אם המחיר יורד מתחתיה. */
  alertBelow?: number;
  /** עמוד המכשיר ב-investing.com — למשיכת מחיר אחרון לקרנות סל שאינן ב-Yahoo. */
  investingUrl?: string;
  /** מספר נייר בבורסת ת"א — לאימות צולב של המחיר מול אתר הבורסה. */
  taseNumber?: string;
  /** סקטור החשיפה של ההחזקה (כולל קרנות) — לחפיפה ולשורת הריכוזיות. */
  sector?: string;
}

export const PORTFOLIO: HoldingDef[] = instrumentConfig.portfolio;

/** Rules on an underlying market for funds without their own chart; a breach turns into an action in the report. */
export const UNDERLYING_TRIGGERS: { taseNumber: string; symbol: string; name: string; below: number; action: string }[] = [
  { taseNumber: "1150721", symbol: "BZ=F", name: "ברנט", below: 100, action: "למכור חצי מקרן האנרגיה (פרמיית המלחמה יצאה מהנפט)" },
];

/**
 * History for an index Yahoo lists without history (207.TA had a single bar on 2026-11-16).
 * The proxy is a 1:1 tracker of the same index; its prices are in agorot, close to the index points.
 */
export const INDEX_HISTORY_PROXY: Record<string, { symbol: string; note: string }> = {
  "207.TA": { symbol: "HRL-F238.TA", note: "היסטוריה מקרן הראל סל ת\"א ביטחוניות (HRL-F238.TA), שעוקבת אחרי המדד 1:1 — ל-Yahoo אין היסטוריה למדד עצמו" },
};

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
  { symbol: "^GSPE", name: "S&P 500 Energy", region: "ארה\"ב" },
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
