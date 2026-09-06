/**
 * מצב שוק (Market Regime) ורוחב שוק (Breadth) — מסנן-על שמונע קניית פריצות
 * כשהשוק כולו בלחץ. מחושב ממדד ייחוס + מצב כלל המניות שבמעקב.
 */
import type { Candle } from "./data.js";
import { sma } from "./indicators.js";
import { PARAMS } from "./config.js";

export type RegimeLabel = "ריסק-און" | "ניטרלי" | "ריסק-אוף";

export interface MarketRegime {
  benchmarkSymbol: string;
  benchmarkName: string;
  price: number;
  aboveSma200: boolean;
  trendUp: boolean;
  /** אחוז המניות שבמעקב הנסחרות מעל ממוצע 50. */
  breadthPct: number;
  advancers: number;
  decliners: number;
  newHighs: number;
  newLows: number;
  score: number;
  label: RegimeLabel;
  notes: string[];
}

export interface RegimeStockInput {
  symbol: string;
  closes: number[];
}

const last = <T,>(a: T[]): T | null => (a.length ? a[a.length - 1] : null);

export function computeRegime(
  benchmark: { symbol: string; name: string; candles: Candle[] },
  stocks: RegimeStockInput[]
): MarketRegime | null {
  const bc = benchmark.candles;
  if (bc.length < 60) return null;
  const closes = bc.map((c) => c.close);
  const price = closes[closes.length - 1];
  const sma200 = closes.length >= 200 ? last(sma(closes, 200)) : null;
  const smaShort = last(sma(closes, PARAMS.smaShort));
  const smaLong = last(sma(closes, PARAMS.smaLong));
  const aboveSma200 = sma200 != null ? price > sma200 : price > (last(sma(closes, 50)) ?? price);
  const trendUp = smaShort != null && smaLong != null && smaShort > smaLong;

  let above50 = 0;
  let counted = 0;
  let advancers = 0;
  let decliners = 0;
  let newHighs = 0;
  let newLows = 0;
  for (const s of stocks) {
    const cs = s.closes;
    if (cs.length < 55) continue;
    counted++;
    const p = cs[cs.length - 1];
    const s50 = last(sma(cs, 50));
    if (s50 != null && p > s50) above50++;
    const prev = cs[cs.length - 2];
    if (p > prev) advancers++;
    else if (p < prev) decliners++;
    const window = cs.slice(-252);
    if (p >= Math.max(...window)) newHighs++;
    if (p <= Math.min(...window)) newLows++;
  }
  const breadthPct = counted ? (above50 / counted) * 100 : 0;

  const notes: string[] = [];
  let score = 0;
  if (aboveSma200) {
    score += 25;
    notes.push(`${benchmark.name} מעל ממוצע 200 — מבנה ארוך טווח חיובי.`);
  } else {
    score -= 25;
    notes.push(`${benchmark.name} מתחת לממוצע 200 — מבנה ארוך טווח שלילי.`);
  }
  if (trendUp) {
    score += 15;
    notes.push(`מגמה קצרה חיובית במדד (ממוצע ${PARAMS.smaShort} מעל ${PARAMS.smaLong}).`);
  } else {
    score -= 15;
    notes.push(`מגמה קצרה שלילית במדד (ממוצע ${PARAMS.smaShort} מתחת ל-${PARAMS.smaLong}).`);
  }
  if (breadthPct >= 60) {
    score += 20;
    notes.push(`רוחב שוק חזק — ${breadthPct.toFixed(0)}% מהמניות מעל ממוצע 50.`);
  } else if (breadthPct <= 40) {
    score -= 20;
    notes.push(`רוחב שוק חלש — רק ${breadthPct.toFixed(0)}% מהמניות מעל ממוצע 50.`);
  } else {
    notes.push(`רוחב שוק ניטרלי — ${breadthPct.toFixed(0)}% מהמניות מעל ממוצע 50.`);
  }
  if (advancers + decliners > 0) {
    const ratio = advancers / Math.max(1, decliners);
    if (ratio >= 2) {
      score += 10;
      notes.push(`יחס עולות/יורדות ${advancers}:${decliners} — השתתפות רחבה בעליות.`);
    } else if (ratio <= 0.5) {
      score -= 10;
      notes.push(`יחס עולות/יורדות ${advancers}:${decliners} — לחץ מכירות רוחבי.`);
    }
  }
  if (newHighs > newLows * 2 && newHighs > 2) {
    score += 8;
    notes.push(`${newHighs} מניות בשיא 52 שבועות מול ${newLows} בשפל.`);
  } else if (newLows > newHighs * 2 && newLows > 2) {
    score -= 8;
    notes.push(`${newLows} מניות בשפל 52 שבועות מול ${newHighs} בשיא — סימן חולשה.`);
  }

  score = Math.max(-100, Math.min(100, score));
  const label: RegimeLabel = score >= 25 ? "ריסק-און" : score <= -25 ? "ריסק-אוף" : "ניטרלי";
  if (label === "ריסק-אוף") {
    notes.push("במצב זה המנוע מחמיר את סף הקנייה ומעדיף המתנה על פני פריצות חדשות.");
  }
  return {
    benchmarkSymbol: benchmark.symbol,
    benchmarkName: benchmark.name,
    price,
    aboveSma200,
    trendUp,
    breadthPct,
    advancers,
    decliners,
    newHighs,
    newLows,
    score,
    label,
    notes,
  };
}
