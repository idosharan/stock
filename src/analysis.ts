/**
 * מנוע הניתוח: משלב את כל האינדיקטורים הטכניים, נזילות, וסנטימנט חדשות
 * לכדי ניקוד והמלצה (קנייה / החזקה / הימנעות) לכל מניה.
 */
import { PARAMS } from "./config.js";
import type { Candle, QuoteInfo } from "./data.js";
import {
  sma,
  rsi,
  macd,
  bollinger,
  stochastic,
  williamsR,
  atr,
  adx,
  obv,
  cci,
  mfi,
  roc,
  rollingVwap,
  detectCandlePatterns,
  analyzeSequences,
  supertrend,
  donchian,
  ichimoku,
  detectDivergence,
  keyLevels,
  anchoredVwap,
  lastSwingLowIndex,
  volumeDryUp,
  chandelierExit,
  relativeStrength,
  type CandlePattern,
  type Divergence,
  type RelativeStrength,
} from "./indicators.js";
import { buildRiskPlan, positionSize, type PositionSize, type RiskPlan } from "./risk.js";
import type { StockNews } from "./news.js";
import type { Fundamentals } from "./fundamentals.js";

export type Recommendation = "קנייה חזקה" | "קנייה" | "החזקה" | "הימנעות / מכירה";

/** הקשר חיצוני לניתוח — מדד ייחוס לחוזק יחסי. */
export interface AnalysisContext {
  benchmarkCloses?: number[];
  benchmarkName?: string;
}

export interface AnalysisResult {
  symbol: string;
  name: string;
  price: number;
  /** ניקוד כולל (-100..100). */
  score: number;
  recommendation: Recommendation;
  /** נימוקים (אותות) להחלטה. */
  signals: string[];
  patterns: CandlePattern[];
  liquidityNote: string;
  /** רמת יציאה לפי שיטת הרצפים — null כשאין רצף עולה פעיל. */
  sequenceStop: number | null;
  /** תוכנית סטופ/יעד ויחס סיכוי/סיכון. */
  risk: RiskPlan | null;
  /** גודל פוזיציה לפי סיכון קבוע מההון. */
  size: PositionSize | null;
  /** רמות תמיכה/התנגדות קרובות. */
  levels: { support: number | null; resistance: number | null };
  /** חוזק יחסי מול מדד הייחוס. */
  relativeStrength: RelativeStrength | null;
  /** דיברגנס בין המחיר ל-RSI. */
  divergence: Divergence;
  /** ימים עד דוחות כספיים קרובים. */
  earningsInDays: number | null;
  newsSentiment: number;
  fundamentals: Fundamentals | null;
  indicators: {
    rsi: number | null;
    macdHist: number | null;
    percentB: number | null;
    smaShort: number | null;
    smaLong: number | null;
    trendUp: boolean;
    stochK: number | null;
    stochD: number | null;
    williamsR: number | null;
    atrPct: number | null;
    adx: number | null;
    obvTrendUp: boolean | null;
    cci: number | null;
    mfi: number | null;
    roc: number | null;
    vwap: number | null;
    supertrendUp: boolean | null;
    ichimokuPosition: string | null;
    chandelier: number | null;
  };
}

function last<T>(arr: T[]): T | null {
  return arr.length ? arr[arr.length - 1] : null;
}

export function analyzeStock(
  symbol: string,
  name: string,
  candles: Candle[],
  quote: QuoteInfo,
  news: StockNews,
  fundamentals?: Fundamentals | null,
  context?: AnalysisContext
): AnalysisResult | null {
  // דורשים מספיק נרות לכל האינדיקטורים (MACD/ADX/CCI/נפח) — אחרת הציון אינו בר-השוואה
  const minCandles =
    Math.max(PARAMS.macdSlow + PARAMS.macdSignal, PARAMS.adxPeriod * 2 + 2, PARAMS.cciPeriod, 20) + 5;
  if (candles.length < minCandles) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const price = closes[closes.length - 1];

  const rsiArr = rsi(closes, PARAMS.rsiPeriod);
  const macdRes = macd(closes, PARAMS.macdFast, PARAMS.macdSlow, PARAMS.macdSignal);
  const bb = bollinger(closes, PARAMS.bbPeriod, PARAMS.bbStdDev);
  const smaShortArr = sma(closes, PARAMS.smaShort);
  const smaLongArr = sma(closes, PARAMS.smaLong);
  const stochRes = stochastic(
    candles,
    PARAMS.stochPeriod,
    PARAMS.stochSmoothK,
    PARAMS.stochSmoothD
  );
  const williamsArr = williamsR(candles, PARAMS.williamsPeriod);
  const atrArr = atr(candles, PARAMS.atrPeriod);
  const adxArr = adx(candles, PARAMS.adxPeriod);
  const obvArr = obv(candles);
  const cciArr = cci(candles, PARAMS.cciPeriod);
  const mfiArr = mfi(candles, PARAMS.mfiPeriod);
  const rocArr = roc(closes, PARAMS.rocPeriod);
  const vwapArr = rollingVwap(candles, PARAMS.vwapPeriod);

  const rsiVal = last(rsiArr);
  const macdHist = last(macdRes.histogram);
  const macdHistPrev = macdRes.histogram[macdRes.histogram.length - 2] ?? null;
  const percentB = last(bb.percentB);
  const smaShortVal = last(smaShortArr);
  const smaLongVal = last(smaLongArr);
  const trendUp = smaShortVal != null && smaLongVal != null && smaShortVal > smaLongVal;
  const smaShortPrev = smaShortArr[smaShortArr.length - 2] ?? null;
  const smaLongPrev = smaLongArr[smaLongArr.length - 2] ?? null;
  const bothSmas =
    smaShortVal != null && smaLongVal != null && smaShortPrev != null && smaLongPrev != null;
  const bullCross = bothSmas && smaShortPrev! <= smaLongPrev! && smaShortVal! > smaLongVal!;
  const bearCross = bothSmas && smaShortPrev! >= smaLongPrev! && smaShortVal! < smaLongVal!;
  const percentBPrev = bb.percentB[bb.percentB.length - 2] ?? null;
  const bbUpperVal = last(bb.upper);
  const lastCandle = candles[candles.length - 1];
  const seq = analyzeSequences(candles);

  const stochK = last(stochRes.k);
  const stochKPrev = stochRes.k[stochRes.k.length - 2] ?? null;
  const stochD = last(stochRes.d);
  const stochDPrev = stochRes.d[stochRes.d.length - 2] ?? null;
  const williamsVal = last(williamsArr);
  const atrVal = last(atrArr);
  const atrPct = atrVal != null && price > 0 ? (atrVal / price) * 100 : null;
  const adxVal = last(adxArr);
  const cciVal = last(cciArr);
  const mfiVal = last(mfiArr);
  const rocVal = last(rocArr);
  const vwapVal = last(vwapArr);
  const obvShortArr = sma(obvArr, PARAMS.smaShort);
  const obvShortVal = last(obvShortArr);
  const obvLongArr = sma(obvArr, PARAMS.smaLong);
  const obvLongVal = last(obvLongArr);
  const obvTrendUp =
    obvShortVal != null && obvLongVal != null ? obvShortVal > obvLongVal : null;

  // אינדיקטורי מגמה משלימים לשיטת הרצפים
  const stArr = supertrend(candles, PARAMS.supertrendPeriod, PARAMS.supertrendMult);
  const stTrend = last(stArr.trend);
  const stTrendPrev = stArr.trend[stArr.trend.length - 2] ?? null;
  const dch = donchian(candles, PARAMS.donchianPeriod);
  const dchUpper = last(dch.upper);
  const dchLower = last(dch.lower);
  const ichi = ichimoku(candles);
  const divergence = detectDivergence(candles, rsiArr);
  const levels = keyLevels(candles);
  const anchorIdx = lastSwingLowIndex(candles);
  const aVwap = anchoredVwap(candles, anchorIdx);
  const dryUp = volumeDryUp(candles);
  const chandelier = chandelierExit(candles, PARAMS.chandelierPeriod, PARAMS.chandelierMult);
  const rs =
    context?.benchmarkCloses && context.benchmarkCloses.length > PARAMS.rsPeriod
      ? relativeStrength(closes, context.benchmarkCloses, PARAMS.rsPeriod)
      : null;

  const patterns = detectCandlePatterns(candles);

  let score = 0;
  const signals: string[] = [];

  // צבירת אותות אוסצילטורים (RSI/סטוכסטי/Williams/CCI/MFI) לשקלול מאוחד עם תקרה —
  // מונע ספירה כפולה של אותה תופעה (מכירת/קניית יתר) ע"י חמישה מדדים מתואמים.
  let oscBull = 0;
  let oscBear = 0;

  // אותות אישור מגמה (Supertrend/Donchian/איצ'ימוקו/חוזק יחסי/VWAP מעוגן) —
  // כולם נדלקים יחד במגמה רצופה, ולכן נצברים לרכיב אחד עם תקרת ±25 ולא לציון ישירות.
  let confirm = 0;

  // 1. מגמה לפי ממוצעים נעים — עדכון בכל קרוס
  if (bullCross) {
    score += 20;
    signals.push(`🔔 קרוס שורי: ממוצע נע ${PARAMS.smaShort} חצה מעל ממוצע ${PARAMS.smaLong}.`);
  } else if (bearCross) {
    score -= 16;
    signals.push(`🔔 קרוס דובי: ממוצע נע ${PARAMS.smaShort} חצה מתחת לממוצע ${PARAMS.smaLong}.`);
  } else if (trendUp) {
    score += 15;
    signals.push(`מגמת עלייה: ממוצע נע ${PARAMS.smaShort} מעל ${PARAMS.smaLong}.`);
  } else if (smaShortVal != null && smaLongVal != null) {
    score -= 10;
    signals.push(`מגמת ירידה/חולשה: ממוצע נע ${PARAMS.smaShort} מתחת ל-${PARAMS.smaLong}.`);
  }

  // 2. מחיר מעל/מתחת לממוצע ארוך
  if (smaLongVal != null) {
    if (price > smaLongVal) {
      score += 8;
      signals.push(`המחיר מעל ממוצע נע ${PARAMS.smaLong} (חוזק).`);
    } else {
      score -= 6;
      signals.push(`המחיר מתחת לממוצע נע ${PARAMS.smaLong} (חולשה).`);
    }
  }

  // 3. RSI
  if (rsiVal != null) {
    if (rsiVal <= PARAMS.rsiOversold) {
      oscBull += 18;
      signals.push(`RSI נמוך (${rsiVal.toFixed(0)}) — מכירת יתר, פוטנציאל תיקון כלפי מעלה.`);
    } else if (rsiVal >= PARAMS.rsiOverbought) {
      oscBear -= 15;
      signals.push(`RSI גבוה (${rsiVal.toFixed(0)}) — קניית יתר, סיכון לתיקון.`);
    } else if (rsiVal >= 45 && rsiVal <= 60) {
      score += 5;
      signals.push(`RSI מאוזן (${rsiVal.toFixed(0)}).`);
    }
  }

  // 4. רצועות בולינגר (%B) — בונוס מלא רק במגמת עלייה (אחרת "סכין נופלת")
  if (percentB != null) {
    if (percentB <= 0.1) {
      if (trendUp) {
        score += 16;
        signals.push("המחיר נוגע/חוצה את הרצועה התחתונה של בולינגר — איתות קנייה אפשרי.");
      } else {
        score += 4;
        signals.push("המחיר ברצועה התחתונה של בולינגר בתוך מגמת ירידה — עדיין לא איתות קנייה.");
      }
    } else if (percentB >= 0.95) {
      score -= 12;
      signals.push("המחיר ברצועה העליונה של בולינגר — מתוח כלפי מעלה.");
    }
  }

  // 4ב. יציאה מהרצועות + נר אדום מעל הרצועה העליונה — עדכון בכל אירוע
  if (percentB != null) {
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
    score -= 14;
    signals.push("🔔 נר אדום מעל רצועת בולינגר העליונה — אזהרת היפוך/מימוש.");
  }

  // 4ג. שיטת הרצפים (אייל גורביץ'): שבירת רצף עולה = מכירה; שבירת רצף יורד = קנייה רק בשפל עולה.
  if (seq) {
    const lvl = seq.breakLevel.toLocaleString("he-IL", { maximumFractionDigits: 2 });
    const higherLow =
      seq.lastTrough != null && seq.prevTrough != null && seq.lastTrough > seq.prevTrough;
    if (seq.flippedToday) {
      if (seq.direction === "down") {
        score -= 20;
        signals.push("🔔 שבירת רצף עולה (שיטת הרצפים) — סגירה מתחת לשפל הנר הגבוה ברצף: איתות מכירה/יציאה.");
      } else if (higherLow && trendUp) {
        score += 18;
        signals.push("🔔 שבירת רצף יורד עם שפל עולה (שיטת הרצפים) — איתות קנייה.");
      } else {
        score += 6;
        signals.push("🔔 שבירת רצף יורד (שיטת הרצפים) — ללא שפל עולה מאושר; איתות קנייה חלקי בלבד.");
      }
    } else if (seq.direction === "up") {
      score += 8;
      signals.push(`רצף עולה פעיל (${seq.length} נרות) — רמת יציאה לפי הרצפים: ${lvl}.`);
    } else {
      score -= 8;
      signals.push(`רצף יורד פעיל (${seq.length} נרות) — "לא קונים ברצף יורד"; היפוך בסגירה מעל ${lvl}.`);
    }
  }

  // 4ד. Supertrend — קו מגמה מבוסס ATR; היפוך שלו מקדים לרוב את חציית הממוצעים
  if (stTrend != null) {
    const flipped = stTrendPrev != null && stTrendPrev !== stTrend;
    if (stTrend === 1) {
      confirm += flipped ? 12 : 8;
      signals.push(
        flipped
          ? "🔔 Supertrend התהפך לחיובי — כניסה למגמת עלייה."
          : "Supertrend חיובי — המגמה תומכת."
      );
    } else {
      confirm -= flipped ? 12 : 8;
      signals.push(
        flipped
          ? "🔔 Supertrend התהפך לשלילי — יציאה ממגמת עלייה."
          : "Supertrend שלילי — המגמה נגד."
      );
    }
  }

  // 4ה. פריצת ערוץ Donchian — שיא/שפל של תקופת המסחר האחרונה
  if (dchUpper != null && dchLower != null) {
    if (price > dchUpper) {
      confirm += 12;
      signals.push(
        `🔔 פריצת שיא ${PARAMS.donchianPeriod} ימים (${dchUpper.toLocaleString("he-IL", { maximumFractionDigits: 2 })}) — פריצה מבנית.`
      );
    } else if (price < dchLower) {
      confirm -= 12;
      signals.push(
        `🔔 שבירת שפל ${PARAMS.donchianPeriod} ימים (${dchLower.toLocaleString("he-IL", { maximumFractionDigits: 2 })}) — חולשה מבנית.`
      );
    }
  }

  // 4ו. Ichimoku — מיקום מול הענן
  if (ichi.position) {
    if (ichi.position === "מעל הענן") {
      confirm += 6;
      signals.push("איצ'ימוקו: המחיר מעל הענן — מבנה מגמה חיובי.");
    } else if (ichi.position === "מתחת לענן") {
      confirm -= 6;
      signals.push("איצ'ימוקו: המחיר מתחת לענן — מבנה מגמה שלילי.");
    } else {
      signals.push("איצ'ימוקו: המחיר בתוך הענן — חוסר הכרעה.");
    }
  }

  // 4ז. דיברגנס מול RSI — אזהרת/הזדמנות היפוך (לא חלק מאישור המגמה — אות עצמאי)
  if (divergence === "bearish") {
    score -= 12;
    signals.push("🔔 דיברגנס שלילי: שיא חדש במחיר ללא שיא חדש ב-RSI — היחלשות מומנטום.");
  } else if (divergence === "bullish") {
    score += 10;
    signals.push("🔔 דיברגנס חיובי: שפל חדש במחיר ללא שפל חדש ב-RSI — התמצות לחץ מכירות.");
  }

  // 4ח. חוזק יחסי מול מדד הייחוס — מניה שמפגרת אחרי השוק אינה מועמדת לקנייה
  if (rs) {
    const bench = context?.benchmarkName ?? "המדד";
    if (rs.excessPct >= 5) {
      confirm += 8;
      signals.push(`חוזק יחסי: תשואה עודפת של ${rs.excessPct.toFixed(1)}% מול ${bench}.`);
    } else if (rs.excessPct <= -5) {
      confirm -= 6;
      signals.push(`פיגור מול ${bench} (${rs.excessPct.toFixed(1)}%) — חולשה יחסית.`);
    }
    if (rs.improving) {
      confirm += 3;
      signals.push(`יחס המחיר מול ${bench} משתפר — רוטציה לטובת המניה.`);
    }
  }

  // 4ט. VWAP מעוגן מהשפל האחרון — מחיר ממוצע של מי שנכנס מאז תחתית התנועה
  if (aVwap != null) {
    if (price > aVwap) {
      confirm += 4;
      signals.push(
        `המחיר מעל VWAP מעוגן מהשפל (${aVwap.toLocaleString("he-IL", { maximumFractionDigits: 2 })}) — הקונים מאז התחתית ברווח.`
      );
    } else {
      confirm -= 3;
      signals.push("המחיר מתחת ל-VWAP המעוגן מהשפל — הקונים האחרונים בהפסד.");
    }
  }

  // 4י. התייבשות נפח בתוך מגמת עלייה — לרוב מקדימה המשך תנועה
  if (dryUp && trendUp) {
    confirm += 3;
    signals.push("התייבשות נפח בתוך מגמת עלייה — לחץ מכירות מתמעט לקראת המשך.");
  }

  // שקלול מאוחד של אישורי המגמה — תקרה הדוקה במכוון: בשוק עולה כל האותות האלה נדלקים
  // במקביל כמעט לכל מניה, ותקרה גבוהה הייתה מוסיפה קבוע לכולם במקום להבדיל ביניהן.
  score += Math.max(-12, Math.min(12, confirm));

  // 5. MACD — חצייה/מומנטום
  if (macdHist != null && macdHistPrev != null) {
    if (macdHist > 0 && macdHistPrev <= 0) {
      score += 14;
      signals.push("חצייה חיובית של MACD — מומנטום עולה.");
    } else if (macdHist < 0 && macdHistPrev >= 0) {
      score -= 12;
      signals.push("חצייה שלילית של MACD — מומנטום יורד.");
    } else if (macdHist > 0) {
      score += 6;
      signals.push("MACD חיובי — מומנטום תומך.");
    } else {
      score -= 4;
    }
  }

  // 6. תבניות נרות יפניים
  for (const p of patterns) {
    if (p.bias === "bullish") {
      score += 10;
      signals.push(`תבנית נר שורית: ${p.name}.`);
    } else if (p.bias === "bearish") {
      score -= 10;
      signals.push(`תבנית נר דובית: ${p.name}.`);
    } else {
      signals.push(`תבנית נר ניטרלית: ${p.name} (חוסר החלטיות).`);
    }
  }

  // 7. נפח מסחר חריג (אישור תנועה)
  const avgVol = sma(volumes, Math.min(20, volumes.length));
  const avgVolVal = last(avgVol);
  const lastVol = volumes[volumes.length - 1];
  if (avgVolVal != null && avgVolVal > 0 && lastVol > avgVolVal * 1.5) {
    score += 6;
    signals.push("נפח מסחר גבוה מהממוצע — אישור לתנועה.");
  }

  // 8. נזילות (היכן יש "כסף נזיל") — מחזור כספי ושווי שוק
  // מניות ת"א מצוטטות באגורות — המרה לשקלים כדי שספי המחזור יהיו נכונים.
  const priceUnitDivisor = symbol.endsWith(".TA") ? 100 : 1;
  // בנרות שבועיים הנפח מצטבר על ~5 ימי מסחר — נרמול למחזור יומי
  const barSpanDays =
    candles.length >= 2
      ? (candles[candles.length - 1].date.getTime() - candles[candles.length - 2].date.getTime()) /
        86_400_000
      : 1;
  const daysPerBar = barSpanDays >= 3 ? 5 : 1;
  const turnover =
    avgVolVal != null && avgVolVal > 0
      ? (avgVolVal * price) / priceUnitDivisor / daysPerBar
      : null;
  let liquidityNote: string;
  if (turnover == null) {
    liquidityNote = "נתוני מחזור חסרים — לא ניתן להעריך נזילות.";
  } else if (turnover >= 5_000_000) {
    score += 6;
    liquidityNote = `נזילות גבוהה (מחזור יומי מוערך ~₪${formatNum(turnover)}).`;
  } else if (turnover >= 1_000_000) {
    score += 2;
    liquidityNote = `נזילות בינונית (מחזור יומי מוערך ~₪${formatNum(turnover)}).`;
  } else {
    score -= 8;
    liquidityNote = `נזילות נמוכה (מחזור יומי מוערך ~₪${formatNum(turnover)}) — סיכון סחירות.`;
  }
  signals.push(liquidityNote);

  // 9. סנטימנט חדשות
  if (news.totalSentiment > 0) {
    score += Math.min(12, news.totalSentiment * 4);
    signals.push(`סנטימנט חדשות חיובי (${news.items.length} כתבות).`);
  } else if (news.totalSentiment < 0) {
    score += Math.max(-12, news.totalSentiment * 4);
    signals.push(`סנטימנט חדשות שלילי (${news.items.length} כתבות) — זהירות.`);
  }

  // 10. אוסצילטור סטוכסטי
  if (stochK != null) {
    if (stochK <= PARAMS.stochOversold) {
      oscBull += 12;
      signals.push(`סטוכסטי נמוך (${stochK.toFixed(0)}) — מכירת יתר.`);
      if (stochKPrev != null && stochDPrev != null && stochK != null && stochD != null && stochKPrev <= stochDPrev && stochK > stochD) {
        oscBull += 6;
        signals.push("חצייה שורית של הסטוכסטי באזור מכירת יתר.");
      }
    } else if (stochK >= PARAMS.stochOverbought) {
      oscBear -= 10;
      signals.push(`סטוכסטי גבוה (${stochK.toFixed(0)}) — קניית יתר.`);
    }
  }

  // 11. Williams %R
  if (williamsVal != null) {
    if (williamsVal <= -80) {
      oscBull += 8;
      signals.push(`Williams %R נמוך (${williamsVal.toFixed(0)}) — מכירת יתר.`);
    } else if (williamsVal >= -20) {
      oscBear -= 8;
      signals.push(`Williams %R גבוה (${williamsVal.toFixed(0)}) — קניית יתר.`);
    }
  }

  // 12. ADX — עוצמת מגמה
  if (adxVal != null) {
    if (adxVal >= PARAMS.adxStrong) {
      if (trendUp) {
        score += 10;
        signals.push(`מגמה חזקה (ADX ${adxVal.toFixed(0)}) בכיוון עלייה.`);
      } else {
        score -= 8;
        signals.push(`מגמה חזקה (ADX ${adxVal.toFixed(0)}) בכיוון ירידה.`);
      }
    } else {
      signals.push(`מגמה חלשה / דשדוש (ADX ${adxVal.toFixed(0)}).`);
    }
  }

  // 13. OBV — אישור נפח למגמה
  if (obvTrendUp != null) {
    if (obvTrendUp) {
      score += 6;
      signals.push("OBV במגמת עלייה — זרימת כסף תומכת.");
    } else {
      score -= 5;
      signals.push("OBV במגמת ירידה — זרימת כסף שלילית.");
    }
  }

  // 14. תנודתיות (ATR) — ניהול סיכון
  if (atrPct != null) {
    if (atrPct > 6) {
      score -= 4;
      signals.push(`תנודתיות גבוהה (ATR ${atrPct.toFixed(1)}%) — סיכון מוגבר.`);
    } else if (atrPct < 2) {
      signals.push(`תנודתיות נמוכה (ATR ${atrPct.toFixed(1)}%).`);
    }
  }

  // 15. CCI — Commodity Channel Index
  if (cciVal != null) {
    if (cciVal <= PARAMS.cciOversold) {
      oscBull += 8;
      signals.push(`CCI נמוך (${cciVal.toFixed(0)}) — מכירת יתר, פוטנציאל היפוך.`);
    } else if (cciVal >= PARAMS.cciOverbought) {
      oscBear -= 7;
      signals.push(`CCI גבוה (${cciVal.toFixed(0)}) — קניית יתר.`);
    }
  }

  // 16. MFI — זרימת כסף משוקללת נפח
  if (mfiVal != null) {
    if (mfiVal <= PARAMS.mfiOversold) {
      oscBull += 9;
      signals.push(`MFI נמוך (${mfiVal.toFixed(0)}) — לחץ מכירות שמתמצה.`);
    } else if (mfiVal >= PARAMS.mfiOverbought) {
      oscBear -= 8;
      signals.push(`MFI גבוה (${mfiVal.toFixed(0)}) — זרימת כסף מתוחה.`);
    }
  }

  // 16ב. שקלול אוסצילטורים מאוחד: בונוס מכירת־יתר מלא רק במגמת עלייה ("קנייה בירידה"
  // ולא "תפיסת סכין נופלת"), ותקרה של ±20 כדי שחמשת המדדים לא ישתלטו על הציון.
  if (oscBull > 0 && !trendUp) {
    oscBull = Math.round(oscBull * 0.3);
    signals.push("אותות מכירת־יתר בתוך מגמת ירידה — משקל מופחת (זהירות מ'סכין נופלת').");
  }
  score += Math.max(-20, Math.min(20, oscBull + oscBear));

  // 17. ROC — מומנטום
  if (rocVal != null) {
    if (rocVal > 5) {
      score += 6;
      signals.push(`מומנטום חיובי (ROC ${rocVal.toFixed(1)}%).`);
    } else if (rocVal < -5) {
      score -= 6;
      signals.push(`מומנטום שלילי (ROC ${rocVal.toFixed(1)}%).`);
    }
  }

  // 18. VWAP — מחיר מול ממוצע משוקלל נפח
  if (vwapVal != null) {
    if (price > vwapVal) {
      score += 5;
      signals.push("המחיר מעל VWAP — קונים בשליטה.");
    } else {
      score -= 4;
      signals.push("המחיר מתחת ל-VWAP — מוכרים בשליטה.");
    }
  }

  // 19. ניתוח פונדמנטלי (מוגבל ל-±15 כדי לא להשתלט על הציון הטכני)
  const f = fundamentals ?? null;
  if (f) {
    let fScore = 0;
    const pe = f.trailingPE ?? f.forwardPE;
    if (pe != null && pe > 0) {
      if (pe < 12) {
        fScore += 5;
        signals.push(`מכפיל רווח נמוך (P/E ${pe.toFixed(1)}) — תמחור אטרקטיבי.`);
      } else if (pe <= 25) {
        fScore += 2;
        signals.push(`מכפיל רווח סביר (P/E ${pe.toFixed(1)}).`);
      } else if (pe > 40) {
        fScore -= 4;
        signals.push(`מכפיל רווח גבוה (P/E ${pe.toFixed(1)}) — תמחור יקר.`);
      }
    }
    if (f.earningsGrowth != null) {
      if (f.earningsGrowth > 0.15) {
        fScore += 5;
        signals.push(`צמיחת רווחים חזקה (${(f.earningsGrowth * 100).toFixed(0)}%).`);
      } else if (f.earningsGrowth > 0) {
        fScore += 2;
        signals.push(`צמיחת רווחים חיובית (${(f.earningsGrowth * 100).toFixed(0)}%).`);
      } else if (f.earningsGrowth < -0.1) {
        fScore -= 4;
        signals.push(`שחיקת רווחים (${(f.earningsGrowth * 100).toFixed(0)}%) — סיכון פונדמנטלי.`);
      }
    }
    if (f.revenueGrowth != null) {
      if (f.revenueGrowth > 0.1) {
        fScore += 2;
        signals.push(`צמיחת הכנסות (${(f.revenueGrowth * 100).toFixed(0)}%).`);
      } else if (f.revenueGrowth < -0.1) {
        fScore -= 2;
        signals.push(`ירידה בהכנסות (${(f.revenueGrowth * 100).toFixed(0)}%).`);
      }
    }
    if (f.dividendYield != null && f.dividendYield > 0.03) {
      fScore += 2;
      signals.push(`תשואת דיבידנד ${(f.dividendYield * 100).toFixed(1)}%.`);
    }
    if (f.priceToBook != null && f.priceToBook > 0 && f.priceToBook < 1) {
      fScore += 2;
      signals.push(`נסחרת מתחת להון העצמי (P/B ${f.priceToBook.toFixed(2)}).`);
    }
    if (f.returnOnEquity != null && f.returnOnEquity > 0.15) {
      fScore += 2;
      signals.push(`תשואה גבוהה על ההון (ROE ${(f.returnOnEquity * 100).toFixed(0)}%).`);
    }
    if (f.debtToEquity != null && f.debtToEquity > 200) {
      fScore -= 3;
      signals.push(`מינוף גבוה (חוב/הון ${f.debtToEquity.toFixed(0)}%).`);
    }
    score += Math.max(-15, Math.min(15, fScore));
  }

  // 20. לוח דוחות כספיים — פתיחת פוזיציה ערב דוח היא הימור על גאפ
  let earningsInDays: number | null = null;
  if (f?.earningsDate) {
    const ts = Date.parse(f.earningsDate);
    if (Number.isFinite(ts)) {
      const days = Math.round((ts - Date.now()) / 86_400_000);
      if (days >= 0 && days <= 30) earningsInDays = days;
      if (days >= 0 && days <= PARAMS.earningsWarnDays) {
        score -= 5;
        signals.push(
          `⚠️ דוחות כספיים בעוד ${days === 0 ? "היום" : `${days} ימים`} — סיכון גאפ; עדיף לא לפתוח פוזיציה לפניהם.`
        );
      }
    }
  }

  // 21. כותרות שליליות טריות — התראה נפרדת מעבר לסנטימנט המצרפי
  const freshNegativeNews = news.freshNegative?.length ?? 0;
  if (freshNegativeNews > 0) {
    signals.push(
      `📰 ${freshNegativeNews} כותרות שליליות ביומיים האחרונים: "${news.freshNegative[0].title.slice(0, 90)}".`
    );
  }

  score = Math.round(Math.max(-100, Math.min(100, score)));

  let recommendation: Recommendation;
  if (score >= 45) recommendation = "קנייה חזקה";
  else if (score >= 25) recommendation = "קנייה";
  else if (score >= 0) recommendation = "החזקה";
  else recommendation = "הימנעות / מכירה";

  // כלל גורביץ': "לא קונים בנר אדום" — הערת ריסון להמלצות קנייה
  if (
    (recommendation === "קנייה" || recommendation === "קנייה חזקה") &&
    lastCandle.close < lastCandle.open
  ) {
    signals.push("⚠️ הנר האחרון אדום — לפי כללי הרצפים לא קונים בנר אדום; עדיף להמתין לנר ירוק.");
  }

  const sequenceStop = seq && seq.direction === "up" && !seq.flippedToday ? seq.breakLevel : null;
  const risk = buildRiskPlan({
    price,
    atr: atrVal,
    sequenceStop,
    chandelier,
    support: levels.support,
    resistance: levels.resistance,
  });
  const size = risk ? positionSize(symbol, price, risk.stop) : null;
  if (risk) {
    signals.push(
      `🎯 תוכנית סיכון: סטופ ${risk.stop.toLocaleString("he-IL", { maximumFractionDigits: 2 })} (${risk.stopSource}, ${risk.riskPct.toFixed(1)}%) · ` +
        `יעד ${risk.target.toLocaleString("he-IL", { maximumFractionDigits: 2 })} (${risk.targetSource}) · יחס סיכוי/סיכון ${risk.rr.toFixed(1)}.`
    );
  }

  return {
    symbol,
    name,
    price,
    score,
    recommendation,
    signals,
    patterns,
    liquidityNote,
    sequenceStop,
    risk,
    size,
    levels: { support: levels.support, resistance: levels.resistance },
    relativeStrength: rs,
    divergence,
    earningsInDays,
    newsSentiment: news.totalSentiment,
    fundamentals: f,
    indicators: {
      rsi: rsiVal,
      macdHist,
      percentB,
      smaShort: smaShortVal,
      smaLong: smaLongVal,
      trendUp,
      stochK,
      stochD,
      williamsR: williamsVal,
      atrPct,
      adx: adxVal,
      obvTrendUp,
      cci: cciVal,
      mfi: mfiVal,
      roc: rocVal,
      vwap: vwapVal,
      supertrendUp: stTrend == null ? null : stTrend === 1,
      ichimokuPosition: ichi.position,
      chandelier,
    },
  };
}

/** מבט ארוך טווח (SMA200, חציית זהב, מומנטום חצי-שנתי/שנתי, מרחק משיא 52 שב'). */
export interface LongTermView {
  score: number; // -100..100
  label: "חיובי" | "ניטרלי" | "שלילי";
  signals: string[];
  aboveSma200: boolean;
  goldenCross: boolean;
  offHighPct: number | null;
}

export function analyzeLongTerm(candles: Candle[]): LongTermView | null {
  const closes = candles.map((c) => c.close);
  if (closes.length < 210) return null;
  const price = closes[closes.length - 1];

  const sma50 = last(sma(closes, 50));
  const sma200 = last(sma(closes, 200));
  if (sma50 == null || sma200 == null) return null;

  let s = 0;
  const signals: string[] = [];

  const aboveSma200 = price > sma200;
  if (aboveSma200) {
    s += 12;
    signals.push("המחיר מעל ממוצע 200 — מגמה ארוכת טווח חיובית.");
  } else {
    s -= 12;
    signals.push("המחיר מתחת לממוצע 200 — חולשה ארוכת טווח.");
  }

  const goldenCross = sma50 > sma200;
  if (goldenCross) {
    s += 12;
    signals.push("ממוצע 50 מעל 200 (מבנה חציית זהב).");
  } else {
    s -= 12;
    signals.push("ממוצע 50 מתחת ל-200 (מבנה חציית מוות).");
  }

  // מומנטום חצי-שנתי (~126 ימי מסחר)
  if (closes.length > 126) {
    const rocHalf = ((price - closes[closes.length - 1 - 126]) / closes[closes.length - 1 - 126]) * 100;
    if (rocHalf > 15) { s += 10; signals.push(`מומנטום חצי-שנתי חזק (+${rocHalf.toFixed(0)}%).`); }
    else if (rocHalf > 5) { s += 5; signals.push(`מומנטום חצי-שנתי חיובי (+${rocHalf.toFixed(0)}%).`); }
    else if (rocHalf < -15) { s -= 10; signals.push(`מומנטום חצי-שנתי שלילי (${rocHalf.toFixed(0)}%).`); }
    else if (rocHalf < -5) { s -= 5; signals.push(`מומנטום חצי-שנתי חלש (${rocHalf.toFixed(0)}%).`); }
  }

  // מומנטום שנתי (~252 ימי מסחר)
  if (closes.length > 252) {
    const rocYear = ((price - closes[closes.length - 1 - 252]) / closes[closes.length - 1 - 252]) * 100;
    if (rocYear > 25) { s += 8; signals.push(`תשואה שנתית חזקה (+${rocYear.toFixed(0)}%).`); }
    else if (rocYear > 10) { s += 4; signals.push(`תשואה שנתית חיובית (+${rocYear.toFixed(0)}%).`); }
    else if (rocYear < -20) { s -= 8; signals.push(`תשואה שנתית שלילית (${rocYear.toFixed(0)}%).`); }
    else if (rocYear < -10) { s -= 4; signals.push(`תשואה שנתית חלשה (${rocYear.toFixed(0)}%).`); }
  }

  // מרחק משיא 52 שבועות
  const window = closes.slice(-252);
  const hi52 = Math.max(...window);
  const offHighPct = hi52 > 0 ? ((hi52 - price) / hi52) * 100 : null;
  if (offHighPct != null) {
    if (offHighPct <= 5) { s += 8; signals.push(`קרוב לשיא 52 שבועות (${offHighPct.toFixed(1)}% מתחתיו) — המשכיות מומנטום.`); }
    else if (offHighPct >= 30) { s -= 8; signals.push(`רחוק ${offHighPct.toFixed(0)}% משיא 52 שבועות.`); }
  }

  const score = Math.max(-100, Math.min(100, s * 2));
  const label: LongTermView["label"] = score >= 20 ? "חיובי" : score <= -20 ? "שלילי" : "ניטרלי";
  return { score, label, signals, aboveSma200, goldenCross, offHighPct };
}

/** סיכום רב-אופקי למניה — מחושב ב-runner ומוצג בדוח. */
export interface HorizonInfo {
  weeklyScore: number | null;
  weeklyRec: Recommendation | null;
  longTerm: LongTermView | null;
  /** שקלול: יומי 40% · שבועי 35% · ארוך 25% (מנורמל כשאופק חסר). */
  combined: number;
  alignment: "מלאה" | "חלקית" | "אין";
}

export function buildHorizonInfo(
  dailyScore: number,
  weekly: { score: number; recommendation: Recommendation } | null,
  longTerm: LongTermView | null
): HorizonInfo {
  const parts: Array<[number, number]> = [[dailyScore, 0.4]];
  if (weekly) parts.push([weekly.score, 0.35]);
  if (longTerm) parts.push([longTerm.score, 0.25]);
  const wSum = parts.reduce((a, p) => a + p[1], 0);
  const combined = Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / wSum);

  const positives = [dailyScore >= 20, (weekly?.score ?? -999) >= 20, (longTerm?.score ?? -999) >= 20];
  const posCount = positives.filter(Boolean).length;
  const alignment: HorizonInfo["alignment"] = posCount === 3 ? "מלאה" : posCount === 2 ? "חלקית" : "אין";

  return {
    weeklyScore: weekly?.score ?? null,
    weeklyRec: weekly?.recommendation ?? null,
    longTerm,
    combined,
    alignment,
  };
}

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + " מיליארד";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + " מיליון";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toFixed(0);
}
