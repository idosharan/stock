import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRiskPlan, positionSize, correlationPairs, beta } from "../src/risk.js";
import { analyzeStock } from "../src/analysis.js";
import type { Candle } from "../src/data.js";

const EMPTY_NEWS = { items: [], totalSentiment: 0, freshNegative: [] };

function candlesFrom(closes: number[], volume: number): Candle[] {
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
    sequenceStop: 99.5, // קרוב מדי (פחות מ-0.5×ATR)
    chandelier: 92,
    support: null,
    resistance: null,
  });
  assert.equal(plan!.stop, 92);
  assert.equal(plan!.stopSource, "Chandelier");
});

test("buildRiskPlan מגדיר יעד לפי התנגדות רק כשהיא רחוקה מספיק", () => {
  const near = buildRiskPlan({ price: 100, atr: 2, sequenceStop: 96, chandelier: null, support: null, resistance: 102 });
  assert.equal(near!.targetSource, "2R (התנגדות קרובה)");
  const far = buildRiskPlan({ price: 100, atr: 2, sequenceStop: 96, chandelier: null, support: null, resistance: 120 });
  assert.equal(far!.targetSource, "התנגדות");
  assert.equal(far!.target, 120);
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
