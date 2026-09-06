/**
 * אינדיקטורים לניתוח טכני: ממוצעים נעים, RSI, MACD, רצועות בולינגר
 * וזיהוי תבניות נרות יפניים. כל הפונקציות מקבלות סדרות מספרים/נרות.
 */
import type { Candle } from "./data.js";

/** ממוצע נע פשוט (SMA) — מחזיר מערך באורך הקלט עם null עד שיש מספיק נתונים. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** ממוצע נע מעריכי (EMA). */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      // אתחול עם SMA של התקופה הראשונה
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

/** RSI לפי Wilder. */
export function rsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/** MACD = EMA(fast) - EMA(slow), קו אות = EMA(signal) של MACD. */
export function macd(
  values: number[],
  fast: number,
  slow: number,
  signalPeriod: number
): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: (number | null)[] = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null
      ? (emaFast[i] as number) - (emaSlow[i] as number)
      : null
  );
  const macdDefined = macdLine.map((v) => (v == null ? 0 : v));
  const signalRaw = ema(macdDefined, signalPeriod);
  const signal = signalRaw.map((v, i) => (macdLine[i] == null ? null : v));
  const histogram = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v - (signal[i] as number) : null
  );
  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
  /** מיקום המחיר בתוך הרצועות 0..1 (%B). */
  percentB: (number | null)[];
}

/** רצועות בולינגר. */
export function bollinger(
  values: number[],
  period: number,
  stdDevMult: number
): BollingerResult {
  const middle = sma(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const percentB: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    const m = middle[i];
    if (m == null) {
      upper.push(null);
      lower.push(null);
      percentB.push(null);
      continue;
    }
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (values[j] - m) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    const up = m + stdDevMult * sd;
    const lo = m - stdDevMult * sd;
    upper.push(up);
    lower.push(lo);
    percentB.push(up === lo ? 0.5 : (values[i] - lo) / (up - lo));
  }
  return { middle, upper, lower, percentB };
}

export interface StochasticResult {
  k: (number | null)[];
  d: (number | null)[];
}

/** אוסצילטור סטוכסטי (Stochastic) — %K ו-%D. */
export function stochastic(
  candles: Candle[],
  period: number,
  smoothK: number,
  smoothD: number
): StochasticResult {
  const rawK: (number | null)[] = candles.map((_, i) => {
    if (i < period - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const denom = hh - ll;
    return denom === 0 ? 50 : ((candles[i].close - ll) / denom) * 100;
  });
  const rawKDefined = rawK.map((v) => (v == null ? 0 : v));
  const kSmoothRaw = sma(rawKDefined, smoothK);
  const k = kSmoothRaw.map((v, i) => (rawK[i] == null ? null : v));
  const kDefined = k.map((v) => (v == null ? 0 : v));
  const dRaw = sma(kDefined, smoothD);
  const d = dRaw.map((v, i) => (k[i] == null ? null : v));
  return { k, d };
}

/** Williams %R — נע בין -100 ל-0. */
export function williamsR(candles: Candle[], period: number): (number | null)[] {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const denom = hh - ll;
    return denom === 0 ? -50 : ((hh - candles[i].close) / denom) * -100;
  });
}

/** Average True Range (ATR) לפי Wilder. */
export function atr(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  });
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prevAtr = sum / period;
  out[period] = prevAtr;
  for (let i = period + 1; i < candles.length; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

/** ADX — עוצמת מגמה (ללא כיוון). לפי Wilder. */
export function adx(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const n = candles.length;
  if (n <= period * 2) return out;
  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += tr[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }
  const dxArr: (number | null)[] = new Array(n).fill(null);
  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusSum = plusSum - plusSum / period + plusDM[i];
    minusSum = minusSum - minusSum / period + minusDM[i];
    const plusDI = trSum === 0 ? 0 : (plusSum / trSum) * 100;
    const minusDI = trSum === 0 ? 0 : (minusSum / trSum) * 100;
    const diSum = plusDI + minusDI;
    dxArr[i] = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  }
  // ADX = ממוצע נע מוחלק של DX
  const firstDx = period + 1;
  let count = 0;
  let dxSum = 0;
  for (let i = firstDx; i < firstDx + period && i < n; i++) {
    if (dxArr[i] != null) {
      dxSum += dxArr[i] as number;
      count++;
    }
  }
  if (count < period) return out;
  let prevAdx = dxSum / count;
  const adxStart = firstDx + period - 1;
  if (adxStart < n) out[adxStart] = prevAdx;
  for (let i = adxStart + 1; i < n; i++) {
    if (dxArr[i] == null) continue;
    prevAdx = (prevAdx * (period - 1) + (dxArr[i] as number)) / period;
    out[i] = prevAdx;
  }
  return out;
}

/** On-Balance Volume (OBV). */
export function obv(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) out[i] = out[i - 1] + candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) out[i] = out[i - 1] - candles[i].volume;
    else out[i] = out[i - 1];
  }
  return out;
}

/** Commodity Channel Index (CCI) — סוטה ממחיר טיפוסי ביחס לסטייה ממוצעת. */
export function cci(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const mean = sum / period;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - mean);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
  }
  return out;
}

/** Money Flow Index (MFI) — "RSI משוקלל נפח". */
export function mfi(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rawFlow = candles.map((c, i) => tp[i] * c.volume);
  for (let i = period; i < candles.length; i++) {
    let posFlow = 0;
    let negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += rawFlow[j];
      else if (tp[j] < tp[j - 1]) negFlow += rawFlow[j];
    }
    if (posFlow === 0 && negFlow === 0) out[i] = 50; // חלון ללא תנועה/נפח — ניטרלי, לא קניית יתר
    else if (negFlow === 0) out[i] = 100;
    else {
      const ratio = posFlow / negFlow;
      out[i] = 100 - 100 / (1 + ratio);
    }
  }
  return out;
}

/** Rate of Change (ROC) — מומנטום באחוזים מול תקופה אחורה. */
export function roc(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period];
    out[i] = past === 0 ? null : ((values[i] - past) / past) * 100;
  }
  return out;
}

/** VWAP מתגלגל (Volume Weighted Average Price) על חלון נתון. */
export function rollingVwap(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pv += tp[j] * candles[j].volume;
      vol += candles[j].volume;
    }
    out[i] = vol === 0 ? null : pv / vol;
  }
  return out;
}

/* ---------- מגמה: Supertrend / Donchian / Ichimoku ---------- */

export interface SupertrendResult {
  /** 1 = מגמת עלייה, -1 = מגמת ירידה. */
  trend: (1 | -1 | null)[];
  /** קו ה-Supertrend (משמש כסטופ נגרר). */
  line: (number | null)[];
}

/** Supertrend — קו מגמה מבוסס ATR; היפוך הקו = שינוי מגמה. */
export function supertrend(candles: Candle[], period: number, mult: number): SupertrendResult {
  const n = candles.length;
  const atrArr = atr(candles, period);
  const trend: (1 | -1 | null)[] = new Array(n).fill(null);
  const line: (number | null)[] = new Array(n).fill(null);
  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let prevTrend: 1 | -1 = 1;
  for (let i = 0; i < n; i++) {
    const a = atrArr[i];
    if (a == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * a;
    const basicLower = hl2 - mult * a;
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    finalUpper =
      finalUpper == null || basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower =
      finalLower == null || basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    const close = candles[i].close;
    let t: 1 | -1 = prevTrend;
    if (prevTrend === 1 && close < finalLower) t = -1;
    else if (prevTrend === -1 && close > finalUpper) t = 1;
    trend[i] = t;
    line[i] = t === 1 ? finalLower : finalUpper;
    prevTrend = t;
  }
  return { trend, line };
}

export interface DonchianResult {
  /** שיא/שפל של ה-period נרות שקדמו לנר הנוכחי (לא כולל אותו) — לזיהוי פריצה. */
  upper: (number | null)[];
  lower: (number | null)[];
}

/** ערוץ Donchian מוסט אחורה בנר אחד — פריצה = סגירה מעל שיא התקופה הקודמת. */
export function donchian(candles: Candle[], period: number): DonchianResult {
  const upper: (number | null)[] = new Array(candles.length).fill(null);
  const lower: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

export interface IchimokuState {
  tenkan: number | null;
  kijun: number | null;
  /** ענן הנגזר מהנתונים של לפני displacement נרות (הענן שמעל/מתחת למחיר כעת). */
  spanA: number | null;
  spanB: number | null;
  position: "מעל הענן" | "בתוך הענן" | "מתחת לענן" | null;
}

/** Ichimoku מפושט — מיקום המחיר ביחס לענן ולקווי Tenkan/Kijun. */
export function ichimoku(
  candles: Candle[],
  tenkanP = 9,
  kijunP = 26,
  spanBP = 52
): IchimokuState {
  const n = candles.length;
  const empty: IchimokuState = { tenkan: null, kijun: null, spanA: null, spanB: null, position: null };
  if (n < spanBP + kijunP) return empty;
  const midRange = (from: number, to: number): number => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = from; i <= to; i++) {
      if (candles[i].high > hi) hi = candles[i].high;
      if (candles[i].low < lo) lo = candles[i].low;
    }
    return (hi + lo) / 2;
  };
  const lastIdx = n - 1;
  const tenkan = midRange(lastIdx - tenkanP + 1, lastIdx);
  const kijun = midRange(lastIdx - kijunP + 1, lastIdx);
  // הענן הנוכחי נבנה מנתוני העבר (הזזה קדימה של kijunP נרות)
  const cloudIdx = lastIdx - kijunP;
  const tenkanPast = midRange(cloudIdx - tenkanP + 1, cloudIdx);
  const kijunPast = midRange(cloudIdx - kijunP + 1, cloudIdx);
  const spanA = (tenkanPast + kijunPast) / 2;
  const spanB = midRange(cloudIdx - spanBP + 1, cloudIdx);
  const price = candles[lastIdx].close;
  const top = Math.max(spanA, spanB);
  const bottom = Math.min(spanA, spanB);
  const position: IchimokuState["position"] =
    price > top ? "מעל הענן" : price < bottom ? "מתחת לענן" : "בתוך הענן";
  return { tenkan, kijun, spanA, spanB, position };
}

/* ---------- דיברגנס, רמות מפתח, נפח ועוצמה יחסית ---------- */

export type Divergence = "bullish" | "bearish" | null;

/**
 * מזהה דיברגנס בין המחיר לאוסצילטור: שפל נמוך יותר במחיר מול שפל גבוה יותר
 * באוסצילטור (חיובי) או שיא גבוה יותר במחיר מול שיא נמוך יותר באוסצילטור (שלילי).
 * מוחזר רק כשהפיבוט האחרון טרי (עד maxAge נרות אחורה).
 */
export function detectDivergence(
  candles: Candle[],
  osc: (number | null)[],
  lookback = 60,
  strength = 3,
  maxAge = 6
): Divergence {
  const n = candles.length;
  if (n < lookback) return null;
  const start = Math.max(strength, n - lookback);
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = start; i < n - strength; i++) {
    let isLow = true;
    let isHigh = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (candles[j].high >= candles[i].high) isHigh = false;
    }
    if (isLow && osc[i] != null) lows.push(i);
    if (isHigh && osc[i] != null) highs.push(i);
  }
  const fresh = (idx: number) => n - 1 - idx <= maxAge + strength;

  if (lows.length >= 2) {
    const b = lows[lows.length - 1];
    const a = lows[lows.length - 2];
    if (fresh(b) && candles[b].low < candles[a].low && (osc[b] as number) > (osc[a] as number)) {
      return "bullish";
    }
  }
  if (highs.length >= 2) {
    const b = highs[highs.length - 1];
    const a = highs[highs.length - 2];
    if (fresh(b) && candles[b].high > candles[a].high && (osc[b] as number) < (osc[a] as number)) {
      return "bearish";
    }
  }
  return null;
}

export interface KeyLevels {
  /** התנגדות קרובה מעל המחיר. */
  resistance: number | null;
  /** תמיכה קרובה מתחת למחיר. */
  support: number | null;
  /** כל רמות השיא/שפל שזוהו (swing highs/lows) בטווח הנבדק. */
  highs: number[];
  lows: number[];
}

/** רמות תמיכה/התנגדות לפי שיאים ושפלים מקומיים (swing points). */
export function keyLevels(candles: Candle[], lookback = 120, strength = 3): KeyLevels {
  const n = candles.length;
  const highs: number[] = [];
  const lows: number[] = [];
  const start = Math.max(strength, n - lookback);
  for (let i = start; i < n - strength; i++) {
    let isLow = true;
    let isHigh = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (candles[j].high >= candles[i].high) isHigh = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  const price = candles[n - 1].close;
  const above = highs.filter((h) => h > price).sort((a, b) => a - b);
  const below = lows.filter((l) => l < price).sort((a, b) => b - a);
  return {
    resistance: above.length ? above[0] : null,
    support: below.length ? below[0] : null,
    highs,
    lows,
  };
}

/** VWAP מעוגן — משוקלל נפח מנקודת עיגון (למשל השפל האחרון) ועד הנר האחרון. */
export function anchoredVwap(candles: Candle[], anchorIdx: number): number | null {
  if (anchorIdx < 0 || anchorIdx >= candles.length) return null;
  let pv = 0;
  let vol = 0;
  for (let i = anchorIdx; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += tp * candles[i].volume;
    vol += candles[i].volume;
  }
  if (vol === 0) {
    // ניירות ללא נתוני נפח — ממוצע מחירים פשוט כדי לא לאבד את הרמה
    let sum = 0;
    for (let i = anchorIdx; i < candles.length; i++) sum += candles[i].close;
    return sum / (candles.length - anchorIdx);
  }
  return pv / vol;
}

/** האינדקס של השפל הנמוך ביותר בטווח האחרון — נקודת עיגון ל-VWAP מעוגן. */
export function lastSwingLowIndex(candles: Candle[], lookback = 60): number {
  const start = Math.max(0, candles.length - lookback);
  let idx = start;
  for (let i = start; i < candles.length; i++) {
    if (candles[i].low < candles[idx].low) idx = i;
  }
  return idx;
}

/** התייבשות נפח — הנפח בשלושת הנרות האחרונים נמוך משמעותית מהממוצע. */
export function volumeDryUp(candles: Candle[], period = 20, ratio = 0.6): boolean {
  const n = candles.length;
  if (n < period + 3) return false;
  const vols = candles.map((c) => c.volume);
  if (vols.slice(-period).every((v) => v === 0)) return false;
  const avg = vols.slice(-period).reduce((a, b) => a + b, 0) / period;
  const recent = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
  return avg > 0 && recent < avg * ratio;
}

/** Chandelier Exit — סטופ נגרר לפוזיציית לונג: שיא התקופה פחות mult×ATR. */
export function chandelierExit(candles: Candle[], period = 22, mult = 3): number | null {
  const n = candles.length;
  if (n < period + 1) return null;
  const a = atr(candles, Math.min(period, 14))[n - 1];
  if (a == null) return null;
  let hi = -Infinity;
  for (let i = n - period; i < n; i++) if (candles[i].high > hi) hi = candles[i].high;
  return hi - mult * a;
}

/** מקדם מתאם פירסון בין שתי סדרות באותו אורך. */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a1 = x[i] - mx;
    const b1 = y[i] - my;
    num += a1 * b1;
    dx += a1 * a1;
    dy += b1 * b1;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

/** תשואות יומיות באחוזים מסדרת מחירים. */
export function returns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    out.push(prev === 0 ? 0 : ((values[i] - prev) / prev) * 100);
  }
  return out;
}

export interface RelativeStrength {
  /** תשואה עודפת מול המדד באחוזים על פני התקופה. */
  excessPct: number;
  /** יחס המחיר/מדד עולה = חוזק יחסי משתפר. */
  improving: boolean;
  stockPct: number;
  benchPct: number;
}

/** חוזק יחסי מול מדד ייחוס: תשואה עודפת + כיוון יחס המחירים. */
export function relativeStrength(
  stockCloses: number[],
  benchCloses: number[],
  period: number
): RelativeStrength | null {
  const n = Math.min(stockCloses.length, benchCloses.length);
  if (n <= period) return null;
  const s = stockCloses.slice(-n);
  const b = benchCloses.slice(-n);
  const s0 = s[n - 1 - period];
  const b0 = b[n - 1 - period];
  if (!s0 || !b0) return null;
  const stockPct = ((s[n - 1] - s0) / s0) * 100;
  const benchPct = ((b[n - 1] - b0) / b0) * 100;
  const ratio = s.map((v, i) => (b[i] === 0 ? 0 : v / b[i]));
  const ratioSma = sma(ratio, Math.min(period, ratio.length));
  const improving =
    ratio[n - 1] > (ratioSma[n - 1] ?? ratio[n - 1]);
  return { excessPct: stockPct - benchPct, improving, stockPct, benchPct };
}

/* ---------- שיטת הרצפים (אייל גורביץ' / בורסה גרף) ---------- */

export interface SequenceState {
  /** כיוון הרצף הפעיל. */
  direction: "up" | "down";
  /** מספר נרות מאז תחילת הרצף הנוכחי. */
  length: number;
  /** רמת השבירה: שפל הנר הגבוה ביותר (רצף עולה) / שיא הנר הנמוך ביותר (רצף יורד). */
  breakLevel: number;
  /** הרצף התחלף בנר האחרון (שבירה טרייה). */
  flippedToday: boolean;
  /** שפל אחרון/קודם — נקבעים בכל שבירת רצף יורד. */
  lastTrough: number | null;
  prevTrough: number | null;
  /** שיא אחרון/קודם — נקבעים בכל שבירת רצף עולה. */
  lastPeak: number | null;
  prevPeak: number | null;
}

/**
 * שיטת הרצפים: שבירת רצף עולה = סגירה מתחת לשפל הנר הגבוה ביותר שנקבע ברצף;
 * שבירת רצף יורד = סגירה מעל שיא הנר הנמוך ביותר שנקבע ברצף. כל שבירה מחליפה כיוון.
 */
export function analyzeSequences(candles: Candle[]): SequenceState | null {
  if (candles.length < 3) return null;
  let direction: "up" | "down" = candles[1].close >= candles[0].close ? "up" : "down";
  let startIdx = 0;
  let extremeIdx = 0; // הנר הגבוה ביותר (עולה) / הנמוך ביותר (יורד) ברצף הנוכחי
  let lastPeak: number | null = null;
  let prevPeak: number | null = null;
  let lastTrough: number | null = null;
  let prevTrough: number | null = null;
  let flippedAt = -1;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (direction === "up") {
      if (c.high > candles[extremeIdx].high) extremeIdx = i;
      if (c.close < candles[extremeIdx].low) {
        prevPeak = lastPeak;
        lastPeak = candles[extremeIdx].high;
        direction = "down";
        startIdx = i;
        extremeIdx = i;
        flippedAt = i;
      }
    } else {
      if (c.low < candles[extremeIdx].low) extremeIdx = i;
      if (c.close > candles[extremeIdx].high) {
        prevTrough = lastTrough;
        lastTrough = candles[extremeIdx].low;
        direction = "up";
        startIdx = i;
        extremeIdx = i;
        flippedAt = i;
      }
    }
  }
  const lastIdx = candles.length - 1;
  return {
    direction,
    length: lastIdx - startIdx + 1,
    breakLevel: direction === "up" ? candles[extremeIdx].low : candles[extremeIdx].high,
    flippedToday: flippedAt === lastIdx,
    lastTrough,
    prevTrough,
    lastPeak,
    prevPeak,
  };
}

/* ---------- זיהוי תבניות נרות יפניים ---------- */

export interface CandlePattern {
  name: string;
  /** bullish (חיובי), bearish (שלילי), neutral. */
  bias: "bullish" | "bearish" | "neutral";
}

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}
function range(c: Candle): number {
  return c.high - c.low;
}
function isBull(c: Candle): boolean {
  return c.close > c.open;
}

/**
 * מזהה תבניות נרות יפניים נפוצות בנר/שני הנרות האחרונים.
 */
export function detectCandlePatterns(candles: Candle[]): CandlePattern[] {
  const patterns: CandlePattern[] = [];
  const n = candles.length;
  if (n < 2) return patterns;
  const last = candles[n - 1];
  const prev = candles[n - 2];

  const lastBody = body(last);
  const lastRange = range(last);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);

  // פטיש (Hammer) — צל תחתון ארוך, גוף קטן בחלק העליון
  if (
    lastRange > 0 &&
    lowerWick >= 2 * lastBody &&
    upperWick <= lastBody &&
    lastBody / lastRange < 0.4
  ) {
    patterns.push({ name: "פטיש (Hammer)", bias: "bullish" });
  }

  // כוכב נופל (Shooting Star) — צל עליון ארוך
  if (
    lastRange > 0 &&
    upperWick >= 2 * lastBody &&
    lowerWick <= lastBody &&
    lastBody / lastRange < 0.4
  ) {
    patterns.push({ name: "כוכב נופל (Shooting Star)", bias: "bearish" });
  }

  // דוג'י — גוף זעיר
  if (lastRange > 0 && lastBody / lastRange < 0.1) {
    patterns.push({ name: "דוג'י (Doji)", bias: "neutral" });
  }

  // בליעה שורית (Bullish Engulfing)
  if (
    !isBull(prev) &&
    isBull(last) &&
    last.close >= prev.open &&
    last.open <= prev.close
  ) {
    patterns.push({ name: "בליעה שורית (Bullish Engulfing)", bias: "bullish" });
  }

  // בליעה דובית (Bearish Engulfing)
  if (
    isBull(prev) &&
    !isBull(last) &&
    last.open >= prev.close &&
    last.close <= prev.open
  ) {
    patterns.push({ name: "בליעה דובית (Bearish Engulfing)", bias: "bearish" });
  }

  // תבניות שלושה נרות
  if (n >= 3) {
    const c1 = candles[n - 3];
    const c2 = candles[n - 2];
    const c3 = candles[n - 1];
    const mid2 = (c1.open + c1.close) / 2;

    // כוכב הבוקר (Morning Star) — היפוך שורי
    if (
      !isBull(c1) &&
      body(c2) < body(c1) * 0.5 &&
      isBull(c3) &&
      c3.close > mid2
    ) {
      patterns.push({ name: "כוכב בוקר (Morning Star)", bias: "bullish" });
    }

    // כוכב הערב (Evening Star) — היפוך דובי
    if (
      isBull(c1) &&
      body(c2) < body(c1) * 0.5 &&
      !isBull(c3) &&
      c3.close < mid2
    ) {
      patterns.push({ name: "כוכב ערב (Evening Star)", bias: "bearish" });
    }

    // שלושה חיילים לבנים (Three White Soldiers)
    if (
      isBull(c1) &&
      isBull(c2) &&
      isBull(c3) &&
      c2.close > c1.close &&
      c3.close > c2.close
    ) {
      patterns.push({ name: "שלושה חיילים לבנים (Three White Soldiers)", bias: "bullish" });
    }

    // שלושה עורבים שחורים (Three Black Crows)
    if (
      !isBull(c1) &&
      !isBull(c2) &&
      !isBull(c3) &&
      c2.close < c1.close &&
      c3.close < c2.close
    ) {
      patterns.push({ name: "שלושה עורבים שחורים (Three Black Crows)", bias: "bearish" });
    }
  }

  return patterns;
}
