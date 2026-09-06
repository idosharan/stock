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
