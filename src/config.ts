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
export const WATCHLIST: StockDef[] = [
  { symbol: "TEVA.TA", name: "טבע" },
  { symbol: "NICE.TA", name: "נייס" },
  { symbol: "ESLT.TA", name: "אלביט מערכות" },
  { symbol: "POLI.TA", name: "בנק הפועלים" },
  { symbol: "LUMI.TA", name: "בנק לאומי" },
  { symbol: "DSCT.TA", name: "בנק דיסקונט" },
  { symbol: "MZTF.TA", name: "בנק מזרחי טפחות" },
  { symbol: "FIBI.TA", name: "הבינלאומי" },
  { symbol: "ICL.TA", name: "כיל" },
  { symbol: "NVMI.TA", name: "נובה" },
  { symbol: "CAMT.TA", name: "קמטק" },
  { symbol: "PHOE.TA", name: "הפניקס" },
  { symbol: "HARL.TA", name: "הראל" },
  { symbol: "MGDL.TA", name: "מגדל" },
  { symbol: "CLIS.TA", name: "כלל ביטוח" },
  { symbol: "BEZQ.TA", name: "בזק" },
  { symbol: "ELTR.TA", name: "אלקטרה" },
  { symbol: "STRS.TA", name: "שטראוס" },
  { symbol: "OPCE.TA", name: "OPC אנרגיה" },
  { symbol: "AZRG.TA", name: "עזריאלי" },
  { symbol: "MMHD.TA", name: "מנורה מבטחים" },
  { symbol: "TSEM.TA", name: "טאואר" },
  { symbol: "ENOG.TA", name: "אנרג'יאן" },
  { symbol: "NWMD.TA", name: "ניומד אנרגיה" },
  { symbol: "ORA.TA", name: "אורמת טכנולוגיות" },
  { symbol: "SLARL.TA", name: "סולאראדג'" },
  { symbol: "DLEKG.TA", name: "קבוצת דלק" },
  { symbol: "ARYT.TA", name: "אריות" },
  { symbol: "ALHE.TA", name: "אלוני חץ" },
  { symbol: "AMOT.TA", name: "אמות" },
  { symbol: "MLSR.TA", name: "מליסרון" },
  { symbol: "BIG.TA", name: "ביג מרכזי קניות" },
  { symbol: "ARPT.TA", name: "איירפורט סיטי" },
  { symbol: "SKBN.TA", name: "שיכון ובינוי" },
  { symbol: "AURA.TA", name: "אאורה" },
  { symbol: "AFHL.TA", name: "אפריקה מגורים" },
  { symbol: "PRSK.TA", name: "פריון נטוורקס" },
  { symbol: "NXSN.TA", name: "נקסט ויזן" },
  { symbol: "ELCO.TA", name: "אלקו" },
  { symbol: "DANE.TA", name: "דנאל" },
  { symbol: "FBRT.TA", name: "פתאל" },
  { symbol: "ISCD.TA", name: "ישראכרט" },
  { symbol: "MAXO.TA", name: "מקס סטוק" },
  { symbol: "RIT1.TA", name: "ריט 1" },
  { symbol: "MVNE.TA", name: "מבני תעשייה" },
  { symbol: "ENRG.TA", name: "אנרג'יקס" },
  { symbol: "NOFR.TA", name: "נופר אנרגי" },
  { symbol: "DORL.TA", name: "דוראל אנרגיה" },
  { symbol: "MSKE.TA", name: "משק אנרגיה" },
  { symbol: "TDRN.TA", name: "טלדור" },
  { symbol: "MTRX.TA", name: "מטריקס" },
  { symbol: "ONE.TA", name: "וואן טכנולוגיות" },
  { symbol: "FORTY.TA", name: "פורטיסימו" },
  { symbol: "HLAN.TA", name: "חברה לישראל" },
  { symbol: "PTNR.TA", name: "פרטנר" },
  { symbol: "CEL.TA", name: "סלקום" },
  { symbol: "ILDR.TA", name: "אי.די.בי" },
  { symbol: "DIFI.TA", name: "מימון ישיר" },
  { symbol: "DISI.TA", name: "דיסקונט השקעות (דסק\"ש)" },
  { symbol: "RATI.TA", name: "רציו" },
  { symbol: "ISRA.TA", name: "ישראמקו" },
  { symbol: "FOX.TA", name: "פוקס" },
  { symbol: "RMLI.TA", name: "רמי לוי" },
  { symbol: "VCTR.TA", name: "ויקטורי" },
  { symbol: "SAE.TA", name: "שופרסל" },
  { symbol: "TASE.TA", name: "הבורסה לני\"ע" },
  { symbol: "ORL.TA", name: "בזן" },
  { symbol: "PLRM.TA", name: "פלרם" },
  { symbol: "FRSX.TA", name: "פורסייט" },
  { symbol: "GNRS.TA", name: "ג'נריישן קפיטל" },
  { symbol: "INRM.TA", name: "אינרום" },
  { symbol: "PLSN.TA", name: "פלסון" },
  { symbol: "KEN.TA", name: "קנון הולדינגס" },
  { symbol: "AYAL.TA", name: "איילון" },
  { symbol: "MISH.TA", name: "מישורים" },
  { symbol: "GNGR.TA", name: "ג'י וואן" },
  { symbol: "ARDM.TA", name: "ארדמור" },
  { symbol: "BVC.TA", name: "ביוויו" },
  { symbol: "NYAX.TA", name: "Nayax" },
  { symbol: "GILT.TA", name: "גילת" },
  { symbol: "AUDC.TA", name: "אודיוקודס" },
  { symbol: "FORM.TA", name: "פורמולה מערכות" },
  { symbol: "BRND.TA", name: "ברנד תעשיות" },
  { symbol: "TUZA.TA", name: "טאוזה" },
  { symbol: "PCBT.TA", name: "פי.סי.בי טכנולוגיות" },
  { symbol: "ELWS.TA", name: "אלווייז" },
  { symbol: "ROBO.TA", name: "רובוגרופ" },
  { symbol: "MTRN.TA", name: "מיטרוניקס" },
  { symbol: "ASHO.TA", name: "אשטרום נכסים" },
  { symbol: "ASHG.TA", name: "אשטרום קבוצה" },
  { symbol: "MTAV.TA", name: "מבטח שמיר" },
  { symbol: "DRAL.TA", name: "דוראל" },
  { symbol: "MNIN.TA", name: "מנרב" },
  { symbol: "NTGR.TA", name: "נתנאל גרופ" },
  { symbol: "SHOM.TA", name: "שומרה" },
  { symbol: "TMRP.TA", name: "תמר פטרוליום" },
  { symbol: "NVPT.TA", name: "נאוויטס פטרוליום" },
  { symbol: "BLSR.TA", name: "בלייד ריינג'ר" },
  { symbol: "INCR.TA", name: "אינטרקיור" },
  { symbol: "RPAC.TA", name: "רפק" },
  { symbol: "HGG.TA", name: "חג'ג'" },
  { symbol: "DIMRI.TA", name: "י.ח דמרי" },
  { symbol: "ROTS.TA", name: "רוטשטיין" },
  { symbol: "BONS.TA", name: "בונוס ביוגרופ" },
  { symbol: "GCT.TA", name: "ג'י סיטי" },
  { symbol: "ACKR.TA", name: "אקרשטיין" },
  { symbol: "ALMD.TA", name: "אלמדה" },
  { symbol: "TIGI.TA", name: "ת.י.ג.י" },
  { symbol: "AMDA.TA", name: "מדטכניקה" },
  { symbol: "KMDA.TA", name: "קמהדע" },
  { symbol: "ENLT.TA", name: "אנלייט אנרגיה" },
  { symbol: "AILN.TA", name: "אילקס מדיקל" },
  { symbol: "MGRT.TA", name: "מגרית" },
  { symbol: "NVLG.TA", name: "נובולוג" },
  { symbol: "SPEN.TA", name: "שפיר הנדסה" },
  { symbol: "ELAL.TA", name: "אל על" },
  // מניות חו"ל (נסחרות בדולר, ללא סיומת .TA)
  { symbol: "NVDA", name: "אנבידיה" },
  { symbol: "HPQ", name: "HP Inc" },
  // ספייס אקס הונפקה ב-12.6.2026; תנותח אוטומטית כשיצטברו ~50 ימי מסחר
  { symbol: "SPCX", name: "ספייס אקס" },
];

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

export const PORTFOLIO: HoldingDef[] = [
  { symbol: "DSCT.TA", name: "בנק דיסקונט", entryPrice: 3314.74, taseNumber: "639121" },
  { symbol: "POLI.TA", name: "בנק הפועלים", entryPrice: 7593.39, taseNumber: "662577" },
  { symbol: "MMHD.TA", name: "מנורה מבטחים", entryPrice: 47127.1, alertBelow: 44000, taseNumber: "566018" },
  { symbol: "DISI.TA", name: "דיסקונט השקעות (דסק\"ש)", entryPrice: 797, alertBelow: 790, taseNumber: "639013" },
  { symbol: "SPCX", name: "ספייס אקס", entryPrice: 163.04, note: "$" },
  { symbol: "HPQ", name: "HP Inc", entryPrice: 25, note: "$" },
  { name: "הראל סל ת\"א ביטחוניות", entryPrice: 4749.19, note: "נייר 1233170", triggerIndex: "207.TA",
    investingUrl: "https://www.investing.com/etfs/hrlf238" },
  { name: "קסם ממונפת פי 3 NDX100", entryPrice: 27462.37, note: "נייר 1146976", triggerIndex: "^NDX",
    investingUrl: "https://www.investing.com/etfs/ksm-6d-lev-nasdaq-100-x3-monthly" },
  { name: "קסם ממונפת פי 3 ת\"א 35", entryPrice: 3931.78, note: "נייר 1146380", triggerIndex: "TA35.TA",
    investingUrl: "https://www.investing.com/etfs/ksm-6a-leveraged-ta-35-x3-monthly" },
];

/** סקטורים שהתיק כבר חשוף אליהם (ישירות ודרך קרנות ממונפות) — לאיתות חפיפה בהמלצת היום. */
export const STOCK_SECTORS: Record<string, string> = {
  "POLI.TA": "בנקים", "LUMI.TA": "בנקים", "DSCT.TA": "בנקים", "MZTF.TA": "בנקים", "FIBI.TA": "בנקים",
  "PHOE.TA": "ביטוח", "HARL.TA": "ביטוח", "MGDL.TA": "ביטוח", "CLIS.TA": "ביטוח", "MMHD.TA": "ביטוח", "AYAL.TA": "ביטוח", "SHOM.TA": "ביטוח",
  "ESLT.TA": "ביטחוני", "ARYT.TA": "ביטחוני", "NXSN.TA": "ביטחוני", "ROBO.TA": "ביטחוני",
  "NVDA": "טק ארה\"ב", "SPCX": "טק ארה\"ב", "HPQ": "טק ארה\"ב",
  "DISI.TA": "נדל\"ן", "ILDR.TA": "אחזקות", "HLAN.TA": "אחזקות", "DIFI.TA": "פיננסים חוץ-בנקאי", "ISCD.TA": "פיננסים חוץ-בנקאי",
  "ALHE.TA": "נדל\"ן", "AMOT.TA": "נדל\"ן", "MLSR.TA": "נדל\"ן", "BIG.TA": "נדל\"ן", "ARPT.TA": "נדל\"ן",
  "ASHO.TA": "נדל\"ן", "GCT.TA": "נדל\"ן", "RIT1.TA": "נדל\"ן", "MVNE.TA": "נדל\"ן", "MISH.TA": "נדל\"ן",
  "AURA.TA": "נדל\"ן", "AFHL.TA": "נדל\"ן",
};

/** הסקטורים המוחזקים בתיק (כולל חשיפה דרך פי 3 ת"א 35 לבנקים ופי 3 NDX לטק). */
export const HELD_SECTORS = ["בנקים", "ביטוח", "ביטחוני", "טק ארה\"ב", "נדל\"ן"];

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
