/**
 * ניהול סיכון: בניית תוכנית סטופ/יעד לכל המלצה, חישוב גודל פוזיציה לפי סיכון
 * קבוע מההון, ומדידת ריכוזיות התיק (מתאמים ובטא) — הרכיבים שהיו חסרים למנוע.
 */
import { pearson, returns } from "./indicators.js";
import { RISK } from "./config.js";

export interface RiskPlan {
  /** מחיר הסטופ שנבחר. */
  stop: number;
  /** מקור הסטופ (רצפים / Chandelier / ATR / תמיכה). */
  stopSource: string;
  /** מרחק לסטופ באחוזים מהמחיר (= 1R). */
  riskPct: number;
  target: number;
  targetSource: string;
  /** יחס סיכוי/סיכון. */
  rr: number;
}

export interface RiskInput {
  price: number;
  atr: number | null;
  sequenceStop: number | null;
  chandelier: number | null;
  support: number | null;
  resistance: number | null;
}

/**
 * בוחר את הסטופ ההגיוני ביותר: הגבוה מבין המועמדים שעדיין רחוק מספיק מהמחיר
 * (לפחות 0.5×ATR) כדי לא להיסחף מרעש יומי, ומחשב יעד לפי התנגדות קרובה או 2R.
 */
export function buildRiskPlan(input: RiskInput): RiskPlan | null {
  const { price, atr, sequenceStop, chandelier, support, resistance } = input;
  if (!(price > 0)) return null;
  const atrVal = atr != null && atr > 0 ? atr : price * 0.02;
  const minDistance = atrVal * 0.5;

  const candidates: Array<{ level: number; source: string }> = [];
  if (sequenceStop != null) candidates.push({ level: sequenceStop, source: "רצפים" });
  if (chandelier != null) candidates.push({ level: chandelier, source: "Chandelier" });
  candidates.push({ level: price - 2 * atrVal, source: "2×ATR" });
  if (support != null) candidates.push({ level: support * 0.995, source: "תמיכה" });

  const valid = candidates
    .filter((c) => c.level > 0 && c.level < price - minDistance)
    .sort((a, b) => b.level - a.level);
  const chosen = valid[0] ?? { level: price - 2 * atrVal, source: "2×ATR" };
  const stop = chosen.level;
  const riskAbs = price - stop;
  if (!(riskAbs > 0)) return null;

  let target = price + 2 * riskAbs;
  let targetSource = "2R";
  if (resistance != null && resistance > price) {
    const rrToRes = (resistance - price) / riskAbs;
    if (rrToRes >= 1.5) {
      target = resistance;
      targetSource = "התנגדות";
    } else {
      // התנגדות קרובה מדי — היעד נשאר 2R אך זו אזהרת תקרה
      targetSource = "2R (התנגדות קרובה)";
    }
  }

  return {
    stop,
    stopSource: chosen.source,
    riskPct: (riskAbs / price) * 100,
    target,
    targetSource,
    rr: (target - price) / riskAbs,
  };
}

export interface PositionSize {
  shares: number;
  cost: number;
  riskAmount: number;
  capital: number;
  riskPerTradePct: number;
}

/**
 * גודל פוזיציה לפי סיכון קבוע מההון: מספר מניות = סכום הסיכון / מרחק לסטופ.
 * מניות ת"א מצוטטות באגורות ולכן מחולקות ב-100 להמרה לשקלים.
 */
export function positionSize(symbol: string, price: number, stop: number): PositionSize | null {
  const divisor = symbol.endsWith(".TA") ? 100 : 1;
  const priceUnits = price / divisor;
  const stopUnits = stop / divisor;
  const perShareRisk = priceUnits - stopUnits;
  if (!(perShareRisk > 0) || !(priceUnits > 0)) return null;
  const riskAmount = (RISK.capital * RISK.riskPerTradePct) / 100;
  const shares = Math.floor(riskAmount / perShareRisk);
  if (shares <= 0) return null;
  return {
    shares,
    cost: shares * priceUnits,
    riskAmount,
    capital: RISK.capital,
    riskPerTradePct: RISK.riskPerTradePct,
  };
}

export interface CorrPair {
  a: string;
  b: string;
  nameA: string;
  nameB: string;
  corr: number;
}

/** מתאמי פירסון בין תשואות יומיות של כל זוג החזקות (מעל סף המובהקות). */
export function correlationPairs(
  series: Map<string, { name: string; closes: number[] }>,
  minAbs = 0.6,
  window = 60
): CorrPair[] {
  const keys = [...series.keys()];
  const out: CorrPair[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = series.get(keys[i])!;
      const b = series.get(keys[j])!;
      const ra = returns(a.closes).slice(-window);
      const rb = returns(b.closes).slice(-window);
      const n = Math.min(ra.length, rb.length);
      if (n < 20) continue;
      const c = pearson(ra.slice(-n), rb.slice(-n));
      if (c != null && Math.abs(c) >= minAbs) {
        out.push({ a: keys[i], b: keys[j], nameA: a.name, nameB: b.name, corr: c });
      }
    }
  }
  return out.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));
}

/** בטא מול מדד ייחוס — רגישות התשואות של הנייר לתנועת המדד. */
export function beta(stockCloses: number[], benchCloses: number[], window = 120): number | null {
  const rs = returns(stockCloses).slice(-window);
  const rb = returns(benchCloses).slice(-window);
  const n = Math.min(rs.length, rb.length);
  if (n < 30) return null;
  const x = rb.slice(-n);
  const y = rs.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    varx += (x[i] - mx) ** 2;
  }
  return varx === 0 ? null : cov / varx;
}
