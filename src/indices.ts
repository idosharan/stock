/**
 * ניתוח מדדי מניות מובילים בעולם (ארה"ב, ישראל, אירופה, אסיה) והפקת
 * המלצת מגמה לכל מדד. הניתוח מבוסס על אינדיקטורים טכניים (מגמה, RSI, MACD,
 * ADX, מומנטום) ללא שכבת חדשות/נזילות הרלוונטית למניה בודדת.
 */
import { PARAMS, WORLD_INDICES, type IndexDef } from "./config.js";
import { fetchCandles, resampleWeekly } from "./data.js";
import type { Candle } from "./data.js";
import { sma, rsi, macd, adx, roc, atr, bollinger, analyzeSequences } from "./indicators.js";
import type { Mode } from "./report.js";
import { CollectionBudget } from "./collection-budget.js";

export type MarketStance =
  | "חיובי חזק"
  | "חיובי"
  | "ניטרלי"
  | "שלילי"
  | "שלילי חזק";

export interface IndexAnalysis {
  symbol: string;
  name: string;
  region: IndexDef["region"];
  price: number;
  /** שינוי יומי באחוזים. */
  changePct: number | null;
  score: number;
  stance: MarketStance;
  recommendation: string;
  signals: string[];
  indicators: {
    rsi: number | null;
    macdHist: number | null;
    adx: number | null;
    roc: number | null;
    atrPct: number | null;
    trendUp: boolean;
    aboveSmaLong: boolean;
  };
}

function last<T>(arr: T[]): T | null {
  return arr.length ? arr[arr.length - 1] : null;
}

/** מנתח מדד בודד מתוך נרות OHLCV. */
export function analyzeIndex(def: IndexDef, candles: Candle[]): IndexAnalysis | null {
  if (candles.length < PARAMS.smaLong + 5) return null;

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;

  const rsiVal = last(rsi(closes, PARAMS.rsiPeriod));
  const macdRes = macd(closes, PARAMS.macdFast, PARAMS.macdSlow, PARAMS.macdSignal);
  const macdHist = last(macdRes.histogram);
  const macdHistPrev = macdRes.histogram[macdRes.histogram.length - 2] ?? null;
  const smaShortArr = sma(closes, PARAMS.smaShort);
  const smaLongArr = sma(closes, PARAMS.smaLong);
  const smaShortVal = last(smaShortArr);
  const smaLongVal = last(smaLongArr);
  const smaShortPrev = smaShortArr[smaShortArr.length - 2] ?? null;
  const smaLongPrev = smaLongArr[smaLongArr.length - 2] ?? null;
  const trendUp = smaShortVal != null && smaLongVal != null && smaShortVal > smaLongVal;
  const bothSmas =
    smaShortVal != null && smaLongVal != null && smaShortPrev != null && smaLongPrev != null;
  const bullCross = bothSmas && smaShortPrev! <= smaLongPrev! && smaShortVal! > smaLongVal!;
  const bearCross = bothSmas && smaShortPrev! >= smaLongPrev! && smaShortVal! < smaLongVal!;
  const aboveSmaLong = smaLongVal != null && price > smaLongVal;
  const adxVal = last(adx(candles, PARAMS.adxPeriod));
  const rocVal = last(roc(closes, PARAMS.rocPeriod));
  const atrVal = last(atr(candles, PARAMS.atrPeriod));
  const atrPct = atrVal != null && price > 0 ? (atrVal / price) * 100 : null;
  const bb = bollinger(closes, PARAMS.bbPeriod, PARAMS.bbStdDev);
  const percentB = last(bb.percentB);
  const percentBPrev = bb.percentB[bb.percentB.length - 2] ?? null;
  const bbUpperVal = last(bb.upper);
  const lastCandle = candles[candles.length - 1];
  const seq = analyzeSequences(candles);

  // מדד ה-VIX מתנהג הפוך: עלייה = פחד = שלילי לשוק.
  const isVix = def.symbol === "^VIX";

  let score = 0;
  const signals: string[] = [];

  if (bullCross) {
    score += 22;
    signals.push(`🔔 קרוס שורי: ממוצע ${PARAMS.smaShort} חצה מעל ממוצע ${PARAMS.smaLong}.`);
  } else if (bearCross) {
    score -= 18;
    signals.push(`🔔 קרוס דובי: ממוצע ${PARAMS.smaShort} חצה מתחת לממוצע ${PARAMS.smaLong}.`);
  } else if (trendUp) {
    score += 18;
    signals.push(`מגמת עלייה: ממוצע ${PARAMS.smaShort} מעל ${PARAMS.smaLong}.`);
  } else if (smaShortVal != null && smaLongVal != null) {
    score -= 14;
    signals.push(`מגמת ירידה: ממוצע ${PARAMS.smaShort} מתחת ל-${PARAMS.smaLong}.`);
  }

  if (aboveSmaLong) {
    score += 10;
    signals.push(`המדד נסחר מעל ממוצע נע ${PARAMS.smaLong} (חוזק מבני).`);
  } else if (smaLongVal != null) {
    score -= 8;
    signals.push(`המדד נסחר מתחת לממוצע נע ${PARAMS.smaLong} (חולשה מבנית).`);
  }

  if (rsiVal != null) {
    if (rsiVal <= PARAMS.rsiOversold) {
      score += 12;
      signals.push(`RSI נמוך (${rsiVal.toFixed(0)}) — מכירת יתר, פוטנציאל תיקון מעלה.`);
    } else if (rsiVal >= PARAMS.rsiOverbought) {
      score -= 10;
      signals.push(`RSI גבוה (${rsiVal.toFixed(0)}) — קניית יתר, סיכון לתיקון.`);
    } else if (rsiVal >= 50) {
      score += 5;
      signals.push(`RSI מעל 50 (${rsiVal.toFixed(0)}) — מומנטום חיובי.`);
    }
  }

  if (macdHist != null && macdHistPrev != null) {
    if (macdHist > 0 && macdHistPrev <= 0) {
      score += 14;
      signals.push("חצייה חיובית של MACD — מומנטום מתהפך מעלה.");
    } else if (macdHist < 0 && macdHistPrev >= 0) {
      score -= 12;
      signals.push("חצייה שלילית של MACD — מומנטום מתהפך מטה.");
    } else if (macdHist > 0) {
      score += 6;
      signals.push("MACD חיובי — מומנטום תומך.");
    } else {
      score -= 5;
      signals.push("MACD שלילי — מומנטום חלש.");
    }
  }

  if (adxVal != null) {
    if (adxVal >= PARAMS.adxStrong) {
      signals.push(`מגמה מובהקת (ADX ${adxVal.toFixed(0)}) — הכיוון הנוכחי בעל עוצמה.`);
      score += trendUp ? 8 : -6;
    } else {
      signals.push(`מגמה חלשה / דשדוש (ADX ${adxVal.toFixed(0)}).`);
    }
  }

  if (rocVal != null) {
    if (rocVal > 3) {
      score += 6;
      signals.push(`מומנטום חיובי (ROC ${rocVal.toFixed(1)}%).`);
    } else if (rocVal < -3) {
      score -= 6;
      signals.push(`מומנטום שלילי (ROC ${rocVal.toFixed(1)}%).`);
    }
  }

  if (percentB != null) {
    if (percentB <= 0.05) {
      score += 6;
      signals.push("נגיעה ברצועת בולינגר התחתונה — אזור קנייה אפשרי.");
    } else if (percentB >= 0.95) {
      score -= 5;
      signals.push("נגיעה ברצועת בולינגר העליונה — מתיחות כלפי מעלה.");
    }
    if (percentB > 1) {
      signals.push(
        `🔔 יציאה מבולינגר כלפי מעלה: סגירה מעל הרצועה העליונה${percentBPrev != null && percentBPrev <= 1 ? " (טרייה היום)" : ""}.`
      );
    } else if (percentB < 0) {
      signals.push(
        `🔔 יציאה מבולינגר כלפי מטה: סגירה מתחת לרצועה התחתונה${percentBPrev != null && percentBPrev >= 0 ? " (טרייה היום)" : ""}.`
      );
    }
  }
  if (bbUpperVal != null && lastCandle.close < lastCandle.open && lastCandle.close > bbUpperVal) {
    score -= 10;
    signals.push("🔔 נר אדום מעל רצועת בולינגר העליונה — אזהרת היפוך/מימוש.");
  }

  // שיטת הרצפים (גורביץ') ברמת המדד
  if (seq) {
    const lvl = seq.breakLevel.toLocaleString("he-IL", { maximumFractionDigits: 2 });
    if (seq.flippedToday) {
      if (seq.direction === "down") {
        score -= 12;
        signals.push("🔔 שבירת רצף עולה (שיטת הרצפים) — איתות יציאה/הקטנת חשיפה.");
      } else {
        score += 12;
        signals.push("🔔 שבירת רצף יורד (שיטת הרצפים) — איתות התאוששות.");
      }
    } else if (seq.direction === "up") {
      score += 6;
      signals.push(`רצף עולה פעיל (${seq.length} נרות) — רמת שבירה: ${lvl}.`);
    } else {
      score -= 6;
      signals.push(`רצף יורד פעיל (${seq.length} נרות) — היפוך בסגירה מעל ${lvl}.`);
    }
  }

  // היפוך לוגיקה עבור מדד הפחד VIX
  if (isVix) {
    score = -score;
    signals.push("VIX הפוך לשוק: ציון גבוה כאן = סביבת סיכון נמוכה למניות.");
  }

  score = Math.max(-100, Math.min(100, Math.round(score)));

  let stance: MarketStance;
  if (score >= 40) stance = "חיובי חזק";
  else if (score >= 18) stance = "חיובי";
  else if (score > -18) stance = "ניטרלי";
  else if (score > -40) stance = "שלילי";
  else stance = "שלילי חזק";

  const recMap: Record<MarketStance, string> = {
    "חיובי חזק": "הגדלת חשיפה / נטייה ללונג",
    "חיובי": "חשיפה מוטה חיובית",
    "ניטרלי": "ניטרלי — המתנה לאיתות",
    "שלילי": "הקטנת חשיפה / זהירות",
    "שלילי חזק": "הגנתי — צמצום חשיפה",
  };

  return {
    symbol: def.symbol,
    name: def.name,
    region: def.region,
    price,
    changePct,
    score,
    stance,
    recommendation: recMap[stance],
    signals,
    indicators: {
      rsi: rsiVal,
      macdHist,
      adx: adxVal,
      roc: rocVal,
      atrPct,
      trendUp,
      aboveSmaLong,
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** מושך ומנתח את כל מדדי העולם המוגדרים. */
export async function analyzeWorldIndices(
  mode: Mode = "daily",
  onProgress?: (msg: string) => void,
  collection = new CollectionBudget(label => console.warn(`Index collection timed out: ${label}`))
): Promise<IndexAnalysis[]> {
  const log = (m: string) => {
    onProgress?.(m);
    console.log(m);
  };
  const historyDays = mode === "weekly" ? PARAMS.historyDaysWeekly : PARAMS.historyDays;
  log(`🌍 מנתח ${WORLD_INDICES.length} מדדי עולם (ארה"ב / ישראל / אירופה / אסיה)...`);
  const out: IndexAnalysis[] = [];
  for (const def of WORLD_INDICES) {
    if (collection.expired) break;
    try {
      const daily = await collection.run(def.symbol, () => fetchCandles(def.symbol, historyDays), []);
      const candles = mode === "weekly" ? resampleWeekly(daily) : daily;
      const res = analyzeIndex(def, candles);
      if (res) {
        out.push(res);
        log(`   ✅ ${def.name}: ${res.stance} (ציון ${res.score})`);
      } else {
        log(`   ⚠️  ${def.name}: אין מספיק נתונים.`);
      }
    } catch (err) {
      log(`   ❌ ${def.name} (${def.symbol}): שגיאה — ${(err as Error).message}`);
    }
    if (!collection.expired) await sleep(250);
  }
  return out;
}
