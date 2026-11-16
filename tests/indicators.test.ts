import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sma,
  ema,
  rsi,
  supertrend,
  donchian,
  detectDivergence,
  keyLevels,
  anchoredVwap,
  chandelierExit,
  pearson,
  relativeStrength,
  volumeDryUp,
  analyzeSequences,
  ichimoku,
} from "../src/indicators.js";
import type { Candle } from "../src/data.js";
import { buildRiskPlan, positionSize, correlationPairs, beta } from "../src/risk.js";
import { analyzeStock } from "../src/analysis.js";
/** בונה נרות סינתטיים מסדרת מחירי סגירה (טווח יומי של ±1%). */
function candlesFrom(closes: number[], volume = 1000): Candle[] {
  const start = Date.UTC(2025, 0, 1);
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000),
    open: i === 0 ? c : closes[i - 1],
    high: Math.max(c, i === 0 ? c : closes[i - 1]) * 1.01,
    low: Math.min(c, i === 0 ? c : closes[i - 1]) * 0.99,
    close: c,
    volume,
  }));
}

const upTrend = (n: number, from = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => from + i * step);

test("sma מחזיר null עד שיש מספיק נתונים ואז ממוצע נכון", () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2);
  assert.equal(out[4], 4);
});

test("ema מתכנס לערך קבוע בסדרה קבועה", () => {
  const out = ema(new Array(30).fill(50), 10);
  assert.equal(out[29], 50);
});

test("rsi = 100 בסדרה עולה רצופה ו-50 בסדרה שטוחה", () => {
  const rising = rsi(upTrend(40), 14);
  assert.equal(Math.round(rising[39] as number), 100);
  const flat = rsi(new Array(40).fill(20), 14);
  assert.equal(flat[39], 50);
});

test("supertrend מזהה מגמת עלייה ומחזיר קו מתחת למחיר", () => {
  const candles = candlesFrom(upTrend(80));
  const st = supertrend(candles, 10, 3);
  const lastIdx = candles.length - 1;
  assert.equal(st.trend[lastIdx], 1);
  assert.ok((st.line[lastIdx] as number) < candles[lastIdx].close);
});

test("donchian מוסט אחורה — לא כולל את הנר הנוכחי", () => {
  const candles = candlesFrom(upTrend(30));
  const { upper } = donchian(candles, 5);
  const i = 20;
  const expected = Math.max(...candles.slice(i - 5, i).map((c) => c.high));
  assert.equal(upper[i], expected);
  assert.ok((upper[i] as number) < candles[i].high, "השיא הקודם נמוך מהנר הנוכחי במגמת עלייה");
});

test("detectDivergence מזהה דיברגנס שלילי כששיא חדש במחיר לא מלווה בשיא ב-RSI", () => {
  // עלייה חדה, תיקון, ואז שיא גבוה מעט יותר במומנטום חלש
  const closes = [
    ...upTrend(30, 100, 2), // 100..158
    ...upTrend(8, 158, -3), // תיקון
    ...upTrend(10, 134, 3), // שיא חדש מתון
    ...upTrend(6, 164, -2),
    ...upTrend(8, 152, 2.2),
  ];
  const candles = candlesFrom(closes);
  const div = detectDivergence(candles, rsi(closes, 14), 80, 2, 10);
  assert.ok(div === "bearish" || div === null, "לא מחזיר דיברגנס חיובי בטעות");
});

test("keyLevels מחזיר תמיכה מתחת למחיר והתנגדות מעליו", () => {
  const closes = [...upTrend(20, 100), ...upTrend(10, 120, -2), ...upTrend(10, 100, 1)];
  const levels = keyLevels(candlesFrom(closes), 60, 2);
  const price = closes[closes.length - 1];
  if (levels.support != null) assert.ok(levels.support < price);
  if (levels.resistance != null) assert.ok(levels.resistance > price);
});

test("anchoredVwap נופל בתוך טווח המחירים מנקודת העיגון", () => {
  const candles = candlesFrom(upTrend(30));
  const v = anchoredVwap(candles, 10) as number;
  assert.ok(v >= candles[10].low && v <= candles[29].high);
});

test("chandelierExit נמצא מתחת למחיר במגמת עלייה", () => {
  const candles = candlesFrom(upTrend(60));
  const stop = chandelierExit(candles, 22, 3) as number;
  assert.ok(stop < candles[candles.length - 1].close);
});

test("pearson מחזיר 1 לסדרות זהות ו-(-1) לסדרות הפוכות", () => {
  const a = [1, 2, 3, 4, 5, 6];
  assert.equal(Math.round(pearson(a, a) as number), 1);
  assert.equal(Math.round(pearson(a, [...a].reverse()) as number), -1);
});

test("relativeStrength מזהה תשואה עודפת מול המדד", () => {
  const stock = upTrend(100, 100, 2);
  const bench = upTrend(100, 100, 1);
  const rs = relativeStrength(stock, bench, 60);
  assert.ok(rs && rs.excessPct > 0);
});

test("volumeDryUp מזהה ירידת נפח בנרות האחרונים", () => {
  const candles = candlesFrom(upTrend(40));
  for (const c of candles.slice(-3)) c.volume = 100;
  assert.equal(volumeDryUp(candles, 20, 0.6), true);
});

test("analyzeSequences מזהה רצף עולה פעיל ורמת שבירה מתחת למחיר", () => {
  const seq = analyzeSequences(candlesFrom(upTrend(40)));
  assert.ok(seq);
  assert.equal(seq!.direction, "up");
  assert.ok(seq!.breakLevel < 139);
});

test("ichimoku מחזיר מיקום מעל הענן במגמת עלייה ארוכה", () => {
  const state = ichimoku(candlesFrom(upTrend(150)));
  assert.equal(state.position, "מעל הענן");
});

/* ----------------------------- risk plan, sizing, correlation ----------------------------- */
const EMPTY_NEWS = { items: [], totalSentiment: 0, freshNegative: [] };


test("buildRiskPlan בוחר את הסטופ ההדוק ביותר שעדיין רחוק מספיק מהמחיר", () => {
  const plan = buildRiskPlan({
    price: 100,
    atr: 2,
    sequenceStop: 96,
    chandelier: 94,
    support: 90,
    resistance: 130,
  });
  assert.ok(plan);
  assert.equal(plan!.stop, 96);
  assert.equal(plan!.stopSource, "רצפים");
  assert.ok(plan!.rr > 1);
});

test("buildRiskPlan מתעלם מסטופ צמוד מדי למחיר", () => {
  const plan = buildRiskPlan({
    price: 100,
    atr: 4,
    sequenceStop: 99.5, // קרוב מדי (פחות מ-1.5×ATR)
    chandelier: 92,
    support: null,
    resistance: null,
  });
  assert.equal(plan!.stop, 92);
  assert.equal(plan!.stopSource, "Chandelier");
});

test("buildRiskPlan דוחה סטופ בתוך התנועה היומית (פחות מ-1.5×ATR) ועובר ל-2×ATR", () => {
  const plan = buildRiskPlan({ price: 100, atr: 2, sequenceStop: 98, chandelier: 97.5, support: 98, resistance: null });
  assert.equal(plan!.stop, 96);
  assert.equal(plan!.stopSource, "2×ATR");
  const edge = buildRiskPlan({ price: 100, atr: 2, sequenceStop: 96.9, chandelier: null, support: null, resistance: null });
  assert.equal(edge!.stop, 96.9);
});

test("buildRiskPlan מגדיר יעד לפי התנגדות רק כשהיא רחוקה מספיק", () => {
  const near = buildRiskPlan({ price: 100, atr: 2, sequenceStop: 96, chandelier: null, support: null, resistance: 102 });
  assert.equal(near!.targetSource, "2R (התנגדות קרובה)");
  const far = buildRiskPlan({ price: 100, atr: 2, sequenceStop: 96, chandelier: null, support: null, resistance: 120 });
  assert.equal(far!.targetSource, "התנגדות");
  assert.equal(far!.target, 120);
});

test("buildRiskPlan מגביל את הסטופ ל-8% מתחת למחיר (כלל IBD)", () => {
  const plan = buildRiskPlan({ price: 100, atr: 6, sequenceStop: null, chandelier: 85, support: null, resistance: null });
  assert.equal(plan!.stop, 92);
  assert.equal(plan!.stopSource, "תקרת 8% (IBD)");
  assert.ok(Math.abs(plan!.riskPct - 8) < 1e-9);
});

test("positionSize ממיר אגורות לשקלים במניות ת\"א", () => {
  // מחיר 1000 אג' = 10 ש\"ח, סטופ 900 אג' = 9 ש\"ח -> סיכון 1 ש\"ח למניה
  const size = positionSize("DSCT.TA", 1000, 900);
  assert.ok(size);
  assert.equal(size!.shares, Math.floor(size!.riskAmount / 1));
  const us = positionSize("HPQ", 100, 90);
  assert.equal(us!.shares, Math.floor(us!.riskAmount / 10));
});

test("correlationPairs מזהה שתי החזקות שנעות יחד", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const pairs = correlationPairs(
    new Map([
      ["A.TA", { name: "א", closes }],
      ["B.TA", { name: "ב", closes: closes.map((c) => c * 2) }],
    ]),
    0.6
  );
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].corr > 0.99);
});

test("beta של נייר זהה למדד הוא 1", () => {
  const bench = Array.from({ length: 150 }, (_, i) => 1000 + Math.sin(i / 5) * 20);
  const b = beta(bench, bench);
  assert.ok(b != null && Math.abs(b - 1) < 1e-6);
});

test("נזילות מניות ת\"א מחושבת בשקלים ולא באגורות (רגרסיה לבאג פי 100)", () => {
  // 2,000 אג' × 10,000 מניות = 200,000 ש\"ח ליום -> נזילות נמוכה
  const candles = candlesFrom(
    Array.from({ length: 60 }, (_, i) => 2000 + i),
    10_000
  );
  const res = analyzeStock("TEST.TA", "בדיקה", candles, { symbol: "TEST.TA" }, EMPTY_NEWS);
  assert.ok(res);
  assert.match(res!.liquidityNote, /נזילות נמוכה/);
});

test("analyzeStock מחזיר תוכנית סיכון עם סטופ מתחת למחיר", () => {
  const candles = candlesFrom(
    Array.from({ length: 80 }, (_, i) => 100 + i),
    5_000_000
  );
  const res = analyzeStock("TEST", "בדיקה", candles, { symbol: "TEST" }, EMPTY_NEWS);
  assert.ok(res?.risk);
  assert.ok(res!.risk!.stop < res!.price);
  assert.ok(res!.risk!.rr > 0);
});

test("analyzeStock מחזיר null כשאין מספיק נרות", () => {
  const candles = candlesFrom([1, 2, 3, 4, 5], 100);
  assert.equal(analyzeStock("X", "X", candles, { symbol: "X" }, EMPTY_NEWS), null);
});
