/**
 * Evidence-based engine: research-weighted cross-sectional factors — 12-1/6-1 momentum
 * (Jegadeesh-Titman), 52-week-high proximity (George-Hwang), SMA200 trend (Faber), low volatility
 * (Ang; Frazzini-Pedersen), one-month reversal (Jegadeesh 1990) — the hybrid labels built on them,
 * and the SMA200 trigger for leveraged index funds, plus the funds read through their reference index.
 */
import { analyzeStock, analyzeLongTerm, buildHorizonInfo, type AnalysisResult, type HorizonInfo, type Recommendation } from "./analysis.js";
import type { Candle } from "./data.js";
import { resampleWeekly } from "./data.js";
import { methodCheck, type MethodCheck, type NewsItem, type StockNews } from "./news.js";
import { pearson, returns } from "./indicators.js";

/** Macro and geopolitical context flags — never change stock scores. */
export type MacroFlagId = "oil-shock" | "fear" | "yield-pressure" | "shekel-weakness";

export interface MacroFlag {
  id: MacroFlagId;
  label: string;
  detail: string;
}
export type FactorKey = "momentum" | "high52" | "trend" | "lowVol" | "reversal";
export type FactorWeights = Record<FactorKey, number>;

export const RESEARCH_WEIGHTS: FactorWeights = { momentum: 0.35, high52: 0.2, trend: 0.2, lowVol: 0.15, reversal: 0.1 };
export const EQUAL_WEIGHTS: FactorWeights = { momentum: 0.2, high52: 0.2, trend: 0.2, lowVol: 0.2, reversal: 0.2 };
export const MIN_FACTOR_BARS = 147;

export interface RawFactors {
  mom12_1: number | null;
  mom6_1: number | null;
  high52: number | null;
  trendPrice: number | null;
  trendCross: number | null;
  vol60: number | null;
  ret1m: number | null;
  aboveSma200: boolean | null;
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

export function rawFactors(closes: number[]): RawFactors | null {
  const n = closes.length;
  if (n < MIN_FACTOR_BARS || closes.some((c) => !Number.isFinite(c) || c <= 0)) return null;
  const last = closes[n - 1];
  const back = (k: number): number | null => (n - 1 - k >= 0 ? closes[n - 1 - k] : null);
  const ret = (from: number, to: number): number | null => {
    const a = back(from);
    const b = back(to);
    return a != null && b != null ? b / a - 1 : null;
  };
  const sma200 = n >= 200 ? mean(closes.slice(-200)) : null;
  const sma50 = mean(closes.slice(-50));
  const logs: number[] = [];
  for (let i = n - 60; i < n; i++) logs.push(Math.log(closes[i] / closes[i - 1]));
  const m = mean(logs);
  const vol60 = Math.sqrt(logs.reduce((s, x) => s + (x - m) ** 2, 0) / (logs.length - 1));
  return {
    mom12_1: ret(252, 21),
    mom6_1: ret(126, 21),
    high52: last / Math.max(...closes.slice(-252)),
    trendPrice: sma200 != null ? last / sma200 - 1 : null,
    trendCross: sma200 != null ? sma50 / sma200 - 1 : null,
    vol60,
    ret1m: ret(21, 0),
    aboveSma200: sma200 != null ? last > sma200 : null,
  };
}

export function percentileRanks(values: Array<number | null>): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  const present = values
    .map((v, i) => [v, i] as const)
    .filter((p): p is readonly [number, number] => p[0] != null && Number.isFinite(p[0]))
    .sort((a, b) => a[0] - b[0]);
  if (present.length === 1) out[present[0][1]] = 50;
  if (present.length < 2) return out;
  for (let i = 0; i < present.length; ) {
    let j = i;
    while (j + 1 < present.length && present[j + 1][0] === present[i][0]) j++;
    const pct = ((i + j) / 2 / (present.length - 1)) * 100;
    for (let k = i; k <= j; k++) out[present[k][1]] = pct;
    i = j + 1;
  }
  return out;
}

export interface FactorScore {
  /** -100..100 weighted composite of factor percentiles. */
  score: number;
  /** 0..100 percentile of the composite within the universe. */
  rank: number;
  parts: Record<FactorKey, number>;
  aboveSma200: boolean | null;
}

export function scoreUniverse(
  entries: Array<{ symbol: string; raw: RawFactors }>,
  weights: FactorWeights = RESEARCH_WEIGHTS
): Map<string, FactorScore> {
  const col = (pick: (r: RawFactors) => number | null) => percentileRanks(entries.map((e) => pick(e.raw)));
  const m12 = col((r) => r.mom12_1);
  const m6 = col((r) => r.mom6_1);
  const hi = col((r) => r.high52);
  const tp = col((r) => r.trendPrice);
  const tc = col((r) => r.trendCross);
  const vol = col((r) => (r.vol60 == null ? null : -r.vol60));
  const rev = col((r) => (r.ret1m == null ? null : -r.ret1m));
  const avg = (...xs: Array<number | null>): number => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? mean(v) : 50;
  };
  const keys = Object.keys(weights) as FactorKey[];
  const totalWeight = keys.reduce((s, k) => s + weights[k], 0);
  const composites = entries.map((_, i) => {
    const parts: Record<FactorKey, number> = {
      momentum: avg(m12[i], m6[i]),
      high52: hi[i] ?? 50,
      trend: avg(tp[i], tc[i]),
      lowVol: vol[i] ?? 50,
      reversal: rev[i] ?? 50,
    };
    const weighted = keys.reduce((s, k) => s + weights[k] * parts[k], 0) / totalWeight;
    return { parts, score: Math.round((weighted - 50) * 2) };
  });
  const ranks = percentileRanks(composites.map((c) => c.score));
  return new Map(
    entries.map((e, i) => [
      e.symbol,
      {
        score: composites[i].score,
        rank: Math.round(ranks[i] ?? 50),
        parts: Object.fromEntries(keys.map((k) => [k, Math.round(composites[i].parts[k])])) as Record<FactorKey, number>,
        aboveSma200: e.raw.aboveSma200,
      },
    ])
  );
}

export interface LeverageTrigger {
  aboveSma200: boolean;
  /** Close vs SMA200, percent. */
  distancePct: number;
  sma50BelowSma200: boolean;
  /** Drop from the 252-bar closing high, percent (≥ 0). */
  drawdownPct: number;
  /** Early warning: SMA50 below SMA200 or a 10% drawdown. */
  warning: boolean;
}

export function leverageTrigger(closes: number[]): LeverageTrigger | null {
  if (closes.length < 200 || closes.some((c) => !Number.isFinite(c) || c <= 0)) return null;
  const last = closes[closes.length - 1];
  const sma200 = mean(closes.slice(-200));
  const sma50 = mean(closes.slice(-50));
  const high = Math.max(...closes.slice(-252));
  const drawdownPct = Math.max(0, (1 - last / high) * 100);
  const sma50BelowSma200 = sma50 < sma200;
  return {
    aboveSma200: last > sma200,
    distancePct: (last / sma200 - 1) * 100,
    sma50BelowSma200,
    drawdownPct,
    warning: sma50BelowSma200 || drawdownPct >= 10,
  };
}

/* ----------------------------- IBD-style leadership and core-holding top-ups ----------------------------- */

/** IBD-style RS Rating 1..99: latest quarter 40%, three prior quarters 20% each, ranked across the universe. */
export function rsRatings(entries: Array<{ symbol: string; closes: number[] }>): Map<string, number> {
  const raw = entries.flatMap(({ symbol, closes }) => {
    const n = closes.length;
    if (n < 253 || closes.slice(-253).some((c) => !Number.isFinite(c) || c <= 0)) return [];
    const at = (k: number) => closes[n - 1 - k];
    const q = (from: number, to: number) => at(to) / at(from) - 1;
    return [{ symbol, value: 0.4 * q(63, 0) + 0.2 * q(126, 63) + 0.2 * q(189, 126) + 0.2 * q(252, 189) }];
  });
  const pct = percentileRanks(raw.map((r) => r.value));
  return new Map(raw.map((r, i) => [r.symbol, Math.round(1 + (pct[i] ?? 50) * 0.98)]));
}

/** Up-day volume / down-day volume over the last 65 sessions (13 weeks); IBD's accumulation/distribution idea. */
export function accumulationRatio(candles: Candle[], sessions = 65): number | null {
  if (candles.length < sessions + 1) return null;
  let up = 0;
  let down = 0;
  for (let i = candles.length - sessions; i < candles.length; i++) {
    const move = candles[i].close - candles[i - 1].close;
    const volume = candles[i].volume ?? 0;
    if (move > 0) up += volume;
    else if (move < 0) down += volume;
  }
  return up > 0 && down > 0 ? up / down : null;
}

export interface PivotExtension {
  pivot: number;
  /** Percent above the pivot. */
  pct: number;
}

/** IBD: do not chase a breakout more than 5% above the base high (pivot of the 30 sessions before the last 5). */
export function pivotExtension(candles: Candle[]): PivotExtension | null {
  if (candles.length < 40) return null;
  const base = candles.slice(-35, -5);
  const pivot = Math.max(...base.map((c) => c.high));
  const recent = candles.slice(-5);
  const last = candles[candles.length - 1].close;
  const brokeOut = recent.some((c) => c.close > pivot);
  return brokeOut && pivot > 0 && last > pivot * 1.05 ? { pivot, pct: (last / pivot - 1) * 100 } : null;
}

export type TopUpZoneId = "good" | "fair" | "stretched";
export interface TopUpZone {
  zone: TopUpZoneId;
  label: string;
  reasons: string[];
}

/** When to add to a core holding: avoid stretched prices (IBD), prefer pullbacks or a Morningstar-style discount. */
export function topUpZone(input: { closes: number[]; rsi: number | null; stars: number | null; earningsInDays: number | null; longTerm: string | null }): TopUpZone {
  const { closes, rsi, stars, earningsInDays, longTerm } = input;
  const price = closes[closes.length - 1];
  const sma50 = closes.length >= 50 ? mean(closes.slice(-50)) : null;
  const sma200 = closes.length >= 200 ? mean(closes.slice(-200)) : null;
  const high52 = Math.max(...closes.slice(-252));
  const drawdown = high52 > 0 ? 1 - price / high52 : 0;
  const reasons: string[] = [];
  let zone: TopUpZoneId = "fair";
  const extended = sma50 != null && price > sma50 * 1.1;
  if (extended || (rsi != null && rsi >= 70)) {
    zone = "stretched";
    if (extended) reasons.push(`המחיר ${((price / sma50! - 1) * 100).toFixed(0)}% מעל ממוצע 50 — מתוח`);
    if (rsi != null && rsi >= 70) reasons.push(`RSI ${rsi.toFixed(0)} — קניית יתר`);
  } else {
    if (sma50 != null && price <= sma50 * 1.02 && (sma200 == null || price >= sma200 * 0.9)) {
      zone = "good";
      reasons.push("תיקון לאזור ממוצע 50 בתוך מגמה ארוכה");
    }
    if (drawdown >= 0.15 && longTerm !== "שלילי") {
      zone = "good";
      reasons.push(`${(drawdown * 100).toFixed(0)}% מתחת לשיא השנתי, המגמה הארוכה לא שלילית`);
    }
    if (stars != null && stars >= 4) {
      zone = "good";
      reasons.push(`${stars} כוכבים — המחיר בהנחה ליעד האנליסטים`);
    }
    if (zone === "fair") reasons.push("אין הנחה ואין מתיחות — אפשר לחזק במנות");
  }
  if (earningsInDays != null && earningsInDays >= 0 && earningsInDays <= 10) reasons.push(`דוחות בעוד ${earningsInDays} ימים — עדיף לחזק אחרי הדוח`);
  const label = zone === "good" ? "אזור קנייה טוב" : zone === "stretched" ? "מתוח — לחכות לתיקון" : "סביר";
  return { zone, label, reasons };
}

export interface HybridInput {
  /** Factor percentile 0..100. */
  rank: number;
  riskOff: boolean;
  aboveSma200: boolean | null;
  freshSell: boolean;
}

export interface HybridDecision {
  recommendation: Recommendation;
  waitForConfirmation: boolean;
}

/** Factor percentile decides the label; a fresh technical sell event only delays buys. */
export function hybridRecommendation({ rank, riskOff, aboveSma200, freshSell }: HybridInput): HybridDecision {
  let recommendation: Recommendation;
  if (riskOff) {
    recommendation = rank >= 90 && aboveSma200 === true ? "קנייה חזקה" : rank >= 30 ? "החזקה" : "הימנעות / מכירה";
  } else {
    recommendation = rank >= 80 ? "קנייה חזקה" : rank >= 60 ? "קנייה" : rank >= 30 ? "החזקה" : "הימנעות / מכירה";
  }
  const isBuy = recommendation === "קנייה חזקה" || recommendation === "קנייה";
  return { recommendation, waitForConfirmation: isBuy && freshSell };
}

/* ----------------------------- walk-forward validation ----------------------------- */

export type VariantId = "V0" | "V1" | "V2" | "V3";
const VARIANTS: VariantId[] = ["V0", "V1", "V2", "V3"];
export const VARIANT_LABELS: Record<VariantId, string> = {
  V0: "ציון טכני קיים",
  V1: "פקטורים במשקל שווה",
  V2: "פקטורים במשקלי מחקר",
  V3: "פקטורים + שער תזמון",
};
const MIN_ROWS_PER_DATE = 10;
const ADOPTION_MIN_IC = 0.03;

export interface ValidationRow {
  symbol: string;
  date: string;
  technical: number;
  raw: RawFactors;
  freshSell: boolean;
  fwd: Record<number, number | null>;
}

export interface HorizonStats {
  ic: number | null;
  icT: number | null;
  dates: number;
  /** Mean top-minus-bottom quintile net return, percent. */
  spread: number | null;
  /** Share of positive top-quintile returns, percent. */
  hitRate: number | null;
}

export interface VariantStats {
  variant: VariantId;
  horizons: Record<string, HorizonStats>;
  /** Mean share of top-quintile names replaced between consecutive dates. */
  turnover: number | null;
}

export interface EngineValidation {
  version: 1;
  generatedAt: string;
  horizons: number[];
  keyHorizon: number;
  splitDate: string;
  dates: number;
  symbols: number;
  selection: VariantStats[];
  evaluation: VariantStats[];
  chosen: VariantId;
  adopted: boolean;
  reason: string;
}

function variantScores(rows: ValidationRow[], variant: VariantId): number[] {
  if (variant === "V0") return rows.map((r) => r.technical);
  const scored = scoreUniverse(
    rows.map((r, i) => ({ symbol: String(i), raw: r.raw })),
    variant === "V1" ? EQUAL_WEIGHTS : RESEARCH_WEIGHTS
  );
  return rows.map((r, i) => (variant === "V3" && r.freshSell ? -101 : scored.get(String(i))!.score));
}

function statsFor(groups: Array<[string, ValidationRow[]]>, variant: VariantId, horizons: number[]): VariantStats {
  const acc = new Map(horizons.map((h) => [h, { ics: [] as number[], spreads: [] as number[], hits: [] as number[] }]));
  const turnovers: number[] = [];
  let prevTop: Set<string> | null = null;
  for (const [, rows] of groups) {
    const scores = variantScores(rows, variant);
    const order = rows.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    const q = Math.max(1, Math.floor(rows.length / 5));
    const top = order.slice(0, q);
    const bottom = order.slice(-q);
    const topSet = new Set(top.map((i) => rows[i].symbol));
    const previous: Set<string> | null = prevTop;
    if (previous) turnovers.push([...topSet].filter((s) => !previous.has(s)).length / topSet.size);
    prevTop = topSet;
    for (const h of horizons) {
      const a = acc.get(h)!;
      const idx = rows.map((_, i) => i).filter((i) => rows[i].fwd[h] != null);
      if (idx.length < MIN_ROWS_PER_DATE) continue;
      const ic = pearson(
        percentileRanks(idx.map((i) => scores[i])) as number[],
        percentileRanks(idx.map((i) => rows[i].fwd[h]!)) as number[]
      );
      if (ic != null) a.ics.push(ic);
      const t = top.map((i) => rows[i].fwd[h]).filter((v): v is number => v != null);
      const b = bottom.map((i) => rows[i].fwd[h]).filter((v): v is number => v != null);
      if (t.length && b.length) {
        a.spreads.push(mean(t) - mean(b));
        a.hits.push((t.filter((v) => v > 0).length / t.length) * 100);
      }
    }
  }
  const horizonStats = Object.fromEntries(
    horizons.map((h) => {
      const a = acc.get(h)!;
      const n = a.ics.length;
      const m = n ? mean(a.ics) : null;
      const sd = n > 1 && m != null ? Math.sqrt(a.ics.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) : null;
      const stats: HorizonStats = {
        ic: m,
        icT: m != null && sd ? m / (sd / Math.sqrt(n)) : null,
        dates: n,
        spread: a.spreads.length ? mean(a.spreads) : null,
        hitRate: a.hits.length ? mean(a.hits) : null,
      };
      return [String(h), stats];
    })
  );
  return { variant, horizons: horizonStats, turnover: turnovers.length ? mean(turnovers) : null };
}

/** Compares V0 (technical) with factor variants: the first 60% of dates selects, the last 40% decides adoption. */
export function evaluateEngine(rows: ValidationRow[], horizons: number[], generatedAt: Date): EngineValidation | null {
  const byDate = new Map<string, ValidationRow[]>();
  for (const row of rows) (byDate.get(row.date) ?? byDate.set(row.date, []).get(row.date)!).push(row);
  const groups = [...byDate]
    .filter(([, g]) => g.length >= MIN_ROWS_PER_DATE)
    .sort(([a], [b]) => a.localeCompare(b));
  if (groups.length < 10 || !horizons.length) return null;
  const split = Math.floor(groups.length * 0.6);
  const keyHorizon = horizons.includes(20) ? 20 : Math.max(...horizons);
  const key = String(keyHorizon);
  const selection = VARIANTS.map((v) => statsFor(groups.slice(0, split), v, horizons));
  const evaluation = VARIANTS.map((v) => statsFor(groups.slice(split), v, horizons));
  const icOf = (list: VariantStats[], v: VariantId): number => list.find((s) => s.variant === v)!.horizons[key].ic ?? -Infinity;
  const chosen = (["V1", "V3"] as VariantId[]).reduce<VariantId>(
    (best, v) => (icOf(selection, v) > icOf(selection, best) ? v : best),
    "V2"
  );
  const evalChosen = evaluation.find((s) => s.variant === chosen)!.horizons[key];
  const evalBase = evaluation.find((s) => s.variant === "V0")!.horizons[key];
  const beatsBase = (evalChosen.ic ?? -Infinity) > (evalBase.ic ?? -Infinity);
  const strong = (evalChosen.ic ?? -Infinity) >= ADOPTION_MIN_IC;
  const spreadOk = (evalChosen.spread ?? -Infinity) > 0;
  const adopted = beatsBase && strong && spreadOk;
  const f3 = (v: number | null): string => (v == null ? "לא זמין" : v.toFixed(3));
  const reason = adopted
    ? `${VARIANT_LABELS[chosen]} אומץ: IC${keyHorizon} בתקופת הבדיקה ${f3(evalChosen.ic)} מול ${f3(evalBase.ic)} לציון הקיים, פער חמישונים ${evalChosen.spread!.toFixed(2)}%.`
    : `לא אומץ: ${[
        !beatsBase && "לא עקף את הציון הקיים",
        !strong && `IC${keyHorizon} נמוך מ-${ADOPTION_MIN_IC}`,
        !spreadOk && "פער חמישונים לא חיובי",
      ].filter(Boolean).join(", ")} (IC ${f3(evalChosen.ic)} מול ${f3(evalBase.ic)}).`;
  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    horizons,
    keyHorizon,
    splitDate: groups[split][0],
    dates: groups.length,
    symbols: new Set(rows.map((r) => r.symbol)).size,
    selection,
    evaluation,
    chosen,
    adopted,
    reason,
  };
}

export function describeEngine(engine: EngineValidation | null | undefined): string {
  if (!engine) return "מנוע הפקטורים מוצג בלבד: עדיין לא הורצה בדיקה היסטורית (npm run backtest -- --history-days=1825).";
  return `${engine.adopted ? "מנוע היברידי פעיל" : "מנוע הפקטורים מוצג בלבד"} · ${engine.reason} · נבדק ${engine.generatedAt.slice(0, 10)} על ${engine.symbols} ניירות ו-${engine.dates} תאריכים; רק מניות שקיימות היום (הטיית שורדים).`;
}

/* ----------------------------- macro, geopolitics, exposure ----------------------------- */

export const MACRO_SYMBOLS = { vix: "^VIX", brent: "BZ=F", tnx: "^TNX", usdils: "ILS=X" } as const;

export interface MacroSeries {
  vix?: Candle[];
  brent?: Candle[];
  tnx?: Candle[];
  usdils?: Candle[];
}

const closesOf = (candles?: Candle[]): number[] =>
  (candles ?? []).map((c) => c.close).filter((v) => Number.isFinite(v) && v > 0);
const smaLast = (xs: number[], n: number): number | null => (xs.length >= n ? mean(xs.slice(-n)) : null);
const changePct = (xs: number[], k: number): number | null =>
  xs.length > k ? (xs[xs.length - 1] / xs[xs.length - 1 - k] - 1) * 100 : null;

export function macroFlags(series: MacroSeries): MacroFlag[] {
  const flags: MacroFlag[] = [];
  const brent = closesOf(series.brent);
  const b50 = smaLast(brent, 50);
  const b20 = changePct(brent, 20);
  if (b50 != null && b20 != null && brent[brent.length - 1] > b50 && b20 >= 10) {
    flags.push({ id: "oil-shock", label: "הלם נפט", detail: `ברנט ${brent[brent.length - 1].toFixed(1)}$, +${b20.toFixed(1)}% ב-20 ימים, מעל ממוצע 50` });
  }
  const vix = closesOf(series.vix);
  if (vix.length > 5 && vix[vix.length - 1] > 20 && vix[vix.length - 1] > vix[vix.length - 6]) {
    flags.push({ id: "fear", label: "פחד גבוה", detail: `VIX ${vix[vix.length - 1].toFixed(1)} ועולה` });
  }
  const tnx = closesOf(series.tnx);
  if (tnx.length > 20 && tnx[tnx.length - 1] > 5 && tnx[tnx.length - 1] > tnx[tnx.length - 21]) {
    flags.push({ id: "yield-pressure", label: "לחץ תשואות", detail: `אג"ח ארה"ב 10 שנים ${tnx[tnx.length - 1].toFixed(2)}% ועולה ב-20 ימים` });
  }
  const ils = closesOf(series.usdils);
  const i50 = smaLast(ils, 50);
  const i20 = changePct(ils, 20);
  if (i50 != null && i20 != null && ils[ils.length - 1] > i50 && i20 >= 1.5) {
    flags.push({ id: "shekel-weakness", label: "פיחות שקל", detail: `דולר-שקל ${ils[ils.length - 1].toFixed(3)}, +${i20.toFixed(1)}% ב-20 ימים` });
  }
  return flags;
}

// Ambiguous words stay out: "deal"/"עסקה" (business news), bare "strike" (labor/option strikes),
// bare "עזה" (also the adjective "fierce"), "שדה מוקשים" (idiom), "nuclear power".
const HE_WORDS = [
  "איראן", "איראני", "איראנית", "הורמוז", "חיזבאללה", "חות'י", "חות'ים", "חות׳י", "חות׳ים", "טיל", "טילים", "תקיפה", "תקיפות",
  "מכלית", "מכליות", "מוקש", "מלחמה", "לבנון", "חמאס", "סנקציות", "סנקציה", 'כטב"ם', 'כטב"מים', "כטב״ם", "יירוט", "יירוטים",
  "גרעין", "גרעיני", "גרעינית",
];
const HE_PHRASES = ["הפסקת אש", "משמרות המהפכה", "ים סוף", "רצועת עזה", "מוקש ימי", "מוקשים ימיים"];
const HE_LETTER = "\\u05D0-\\u05EA";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Prefixes ו/ש + ה/ב/ל/מה/כש; a bare מ is excluded ("מטיל" = imposes). Gaza needs a prefix (בעזה, מעזה, לעזה).
const HE_WORD_PATTERN = new RegExp(
  `(?:^|[^${HE_LETTER}])(?:ו|ש)?(?:[הבל]|מה|כש)?(?:${HE_WORDS.map(escapeRe).join("|")})(?![${HE_LETTER}])` +
    `|(?:^|[^${HE_LETTER}])ו?(?:[במל]|מה)עזה(?![${HE_LETTER}])`
);
const EN_TERMS = [
  "iran", "iranian", "hormuz", "hezbollah", "houthis?", "missiles?", "airstrikes?", "air\\s+strikes?", "ceasefire", "tankers?",
  "irgc", "sanctions", "lebanon", "gaza", "hamas", "red\\s+sea", "drones?\\s+(?:strikes?|attacks?)", "invasion",
  "(?:naval|sea)\\s+mines?", "(?:hits?|struck|strikes?)\\s+(?:a\\s+)?mine",
  "nuclear\\s+(?:deal|program|programme|sites?|talks|weapons?|facilit(?:y|ies))",
  "(?<!(?:trade|price|bidding|talent|console|streaming|culture|chip|tariff|currency)\\s)war",
];
const EN_PATTERN = new RegExp(`\\b(?:${EN_TERMS.join("|")})\\b`, "i");

export function isGeoHeadline(title: string): boolean {
  return HE_PHRASES.some((p) => title.includes(p)) || HE_WORD_PATTERN.test(title) || EN_PATTERN.test(title);
}

export interface GeoHistoryEntry {
  date: string;
  share: number;
  count: number;
  total: number;
}

export interface GeoIntensity {
  count: number;
  total: number;
  share: number;
  /** Percentile of today's share against the previous 60 days; null until 20 days are stored. */
  percentile: number | null;
  level: "נמוכה" | "בינונית" | "גבוהה";
  examples: Array<{ title: string; source: string }>;
}

const GEO_MIN_HISTORY = 20;
const GEO_WINDOW = 60;

/**
 * Share of geopolitical headlines in general news (domestic business + general world feeds), ranked
 * against stored history. Topic feeds (Iran/Hormuz searches) are ~100% geo by construction, so they
 * supply example headlines only and never the share.
 */
export function geoHeadlineIntensity(news: NewsItem[], history: GeoHistoryEntry[] = [], topic: NewsItem[] = []): GeoIntensity {
  const matches = news.filter((n) => isGeoHeadline(n.title));
  const share = news.length ? matches.length / news.length : 0;
  const past = history.slice(-GEO_WINDOW);
  let percentile: number | null = null;
  let level: GeoIntensity["level"];
  if (past.length >= GEO_MIN_HISTORY) {
    const below = past.filter((h) => h.share < share).length;
    const equal = past.filter((h) => h.share === share).length;
    percentile = Math.round(((below + equal / 2) / past.length) * 100);
    level = percentile >= 80 ? "גבוהה" : percentile >= 50 ? "בינונית" : "נמוכה";
  } else {
    // provisional thresholds until 20 days of history exist; counts don't scale with the number of feeds
    level = share >= 0.08 ? "גבוהה" : share >= 0.03 ? "בינונית" : "נמוכה";
  }
  const freshest = [...topic.filter((n) => isGeoHeadline(n.title)), ...matches]
    .filter((n, i, all) => all.findIndex((m) => m.title === n.title) === i)
    .sort((a, b) => (a.ageHours ?? Infinity) - (b.ageHours ?? Infinity));
  return {
    count: matches.length, total: news.length, share, percentile, level,
    examples: freshest.slice(0, 5).map((n) => ({ title: n.title.slice(0, 140), source: n.source })),
  };
}

export function appendGeoHistory(history: GeoHistoryEntry[], entry: GeoHistoryEntry, limit = 120): GeoHistoryEntry[] {
  return [...history.filter((h) => h.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
}

export interface MacroView {
  flags: MacroFlag[];
  geo: GeoIntensity;
  underlying?: UnderlyingStatus[];
}

export interface UnderlyingStatus {
  taseNumber: string;
  symbol: string;
  name: string;
  below: number;
  action: string;
  price: number;
  date: string;
  hit: boolean;
  distancePct: number;
}

export function underlyingStatus(
  rule: { taseNumber: string; symbol: string; name: string; below: number; action: string },
  candles: Candle[] | undefined,
): UnderlyingStatus | null {
  const last = candles?.at(-1);
  if (!last || !Number.isFinite(last.close) || last.close <= 0) return null;
  return { ...rule, price: last.close, date: last.date.toISOString().slice(0, 10), hit: last.close < rule.below, distancePct: (last.close / rule.below - 1) * 100 };
}

export function underlyingText(s: UnderlyingStatus): string {
  const price = s.price.toFixed(2);
  return s.hit
    ? `🚨 ${s.name} ${price} מתחת ל-${s.below} — הכלל: ${s.action}`
    : `${s.name} ${price} · טריגר מתחת ל-${s.below} (עוד ${s.distancePct.toFixed(1)}%) → ${s.action}`;
}

export interface SensitivityRow {
  name: string;
  symbol: string;
  leverage: number;
  betaNdx: number | null;
  betaBrent: number | null;
  betaTa35: number | null;
  betaUsdIls: number | null;
  /** Estimated holding move in % for each single-factor shock, already multiplied by leverage. */
  brentUp10: number | null;
  ndxDown5: number | null;
  ta35Down5: number | null;
  usdUp3: number | null;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** OLS beta of same-date daily returns over the last `window` shared sessions. */
function alignedBeta(a: Candle[], b: Candle[] | undefined, window: number): number | null {
  if (!b?.length) return null;
  const closesB = new Map(b.map((c) => [isoDay(c.date), c.close]));
  const pairs = a
    .map((c) => [c.close, closesB.get(isoDay(c.date))] as const)
    .filter((p): p is readonly [number, number] => p[1] != null && p[0] > 0 && p[1] > 0)
    .slice(-(window + 1));
  if (pairs.length < 21) return null;
  const ra = returns(pairs.map((p) => p[0]));
  const rb = returns(pairs.map((p) => p[1]));
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    varB += (rb[i] - mb) ** 2;
  }
  return varB > 0 ? cov / varB : null;
}

export function leverageOf(name: string): number {
  return /פי\s*3|x3/i.test(name) ? 3 : 1;
}

export function sensitivityMatrix(
  holdings: Array<{ name: string; symbol: string; candles: Candle[]; leverage?: number; usdDenominated?: boolean }>,
  drivers: { ndx?: Candle[]; brent?: Candle[]; ta35?: Candle[]; usdils?: Candle[] },
  window = 60
): SensitivityRow[] {
  return holdings.map((h) => {
    const leverage = h.leverage ?? 1;
    const betaNdx = alignedBeta(h.candles, drivers.ndx, window);
    const betaBrent = alignedBeta(h.candles, drivers.brent, window);
    const betaTa35 = alignedBeta(h.candles, drivers.ta35, window);
    const betaUsdIls = alignedBeta(h.candles, drivers.usdils, window);
    const move = (beta: number | null, shock: number): number | null => (beta == null ? null : beta * shock * leverage);
    // A dollar-priced holding also gains the currency move itself when measured in shekels.
    const usdMove = move(betaUsdIls, 3);
    return {
      name: h.name, symbol: h.symbol, leverage, betaNdx, betaBrent, betaTa35, betaUsdIls,
      brentUp10: move(betaBrent, 10), ndxDown5: move(betaNdx, -5), ta35Down5: move(betaTa35, -5),
      usdUp3: usdMove == null ? null : usdMove + (h.usdDenominated ? 3 : 0),
    };
  });
}

/* ----------------------------- funds read through their reference index ----------------------------- */
/* Funds without a usable chart (leveraged and index funds): the full stock engine runs on the index candles,
   and the index's stop/target are translated into fund prices. */

export type Market = "TASE" | "US" | "OTHER";
export type FundAction = "קנייה / חיזוק" | "החזקה" | "צמצום / מכירה";

export const MARKET_LABEL: Record<Market, string> = { TASE: "תל אביב", US: 'ארה"ב', OTHER: 'חו"ל אחר' };

const US_INDICES = new Set(["^GSPC", "^DJI", "^IXIC", "^NDX", "^RUT", "^GSPE", "^VIX"]);

/** Market a symbol belongs to: TASE by the .TA suffix, US by a plain ticker or a US index, anything else is OTHER. */
export function marketOf(symbol: string): Market {
  if (symbol.endsWith(".TA")) return "TASE";
  if (US_INDICES.has(symbol) || /^[A-Z][A-Z.-]{0,5}$/.test(symbol)) return "US";
  return "OTHER";
}

const NO_NEWS: StockNews = { items: [], totalSentiment: 0, freshNegative: [] };

/** Combined score at or above this, together with a buy label from the engine, lets a fund be added to. */
export const FUND_BUY_MIN_COMBINED = 20;
/** Combined score at or below this, below the 150-day average, means reduce. */
export const FUND_WEAK_COMBINED = -20;

export interface FundDecisionInput {
  recommendation: Recommendation;
  combined: number;
  method: MethodCheck | null;
  trigger: LeverageTrigger | null;
  leverage: number;
  riskOff: boolean;
}

const pct = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/**
 * Reduce: a leveraged fund whose index is below its 200-day average (the engine's leverage rule), or an index below
 * its 150-day average that is weak on all horizons (Micha Stocks' warning light).
 * Buy: an engine buy label, combined ≥ 20, none of his rules blocking, and for leverage: above SMA200, no early warning, no risk-off.
 */
export function fundDecision(x: FundDecisionInput): { action: FundAction; reasons: string[] } {
  const below150 = x.method?.sma150Pct != null && x.method.sma150Pct < 0;
  const weak = x.combined <= FUND_WEAK_COMBINED || x.recommendation === "הימנעות / מכירה";
  const reduce: string[] = [];
  if (x.leverage > 1 && x.trigger && !x.trigger.aboveSma200) {
    reduce.push(`המדד ${pct(x.trigger.distancePct)} מממוצע 200 — בקרן ממונפת ×${x.leverage} הכלל הוא לצמצם (שחיקת מינוף בשוק יורד)`);
  }
  if (below150 && weak) {
    reduce.push(`המדד מתחת לממוצע 150 (${pct(x.method!.sma150Pct!)}) וחלש בכל האופקים (משולב ${x.combined}) — נורת האזהרה של מיכה סטוקס`);
  }
  if (reduce.length) return { action: "צמצום / מכירה", reasons: reduce };

  const isBuy = x.recommendation === "קנייה" || x.recommendation === "קנייה חזקה";
  const blockers: string[] = [];
  if (!isBuy) blockers.push(`המלצת המנוע למדד: ${x.recommendation}`);
  if (x.combined < FUND_BUY_MIN_COMBINED) blockers.push(`ציון משולב ${x.combined} (לחיזוק נדרש ${FUND_BUY_MIN_COMBINED}+)`);
  if (x.method?.blocks.length) blockers.push(...x.method.blocks);
  if (x.leverage > 1) {
    if (x.riskOff) blockers.push("מצב שוק ריסק-אוף — לא מגדילים חשיפה ממונפת");
    if (x.trigger?.warning) blockers.push(x.trigger.sma50BelowSma200 ? "ממוצע 50 מתחת לממוצע 200 — אזהרה מוקדמת" : `ירידה של ${x.trigger.drawdownPct.toFixed(1)}% מהשיא — אזהרה מוקדמת`);
  }
  if (!blockers.length) {
    return { action: "קנייה / חיזוק", reasons: [`המלצת המנוע למדד: ${x.recommendation} · משולב ${x.combined}`, ...(x.method?.sma150Pct != null ? [`מעל ממוצע 150 (${pct(x.method.sma150Pct)})`] : [])] };
  }
  return { action: "החזקה", reasons: blockers };
}

export interface FundLevels {
  /** Fund-equivalent stop: the index's risk distance multiplied by the leverage. Approximate (daily rebalancing). */
  stop: number;
  target: number;
  riskPct: number;
  rewardPct: number;
}

export function fundLevels(fundPrice: number | null, leverage: number, index: AnalysisResult): FundLevels | null {
  if (fundPrice == null || !(fundPrice > 0) || !index.risk) return null;
  const riskPct = Math.min(95, index.risk.riskPct * leverage);
  const rewardPct = (index.risk.target / index.price - 1) * 100 * leverage;
  return { stop: fundPrice * (1 - riskPct / 100), target: fundPrice * (1 + rewardPct / 100), riskPct, rewardPct };
}

export interface FundIndexView {
  name: string;
  /** TASE security number of the fund. */
  id: string;
  indexSymbol: string;
  indexName: string;
  /** Symbol whose candles were analysed (the index, or its 1:1 tracker). */
  historySymbol: string;
  historyNote?: string;
  leverage: number;
  /** Market of the index — decides where the fund appears in the per-market lists. */
  market: Market;
  fundPrice: number | null;
  analysis: AnalysisResult;
  horizon: HorizonInfo;
  method: MethodCheck | null;
  trigger: LeverageTrigger | null;
  sma200: number | null;
  action: FundAction;
  reasons: string[];
  fund: FundLevels | null;
}

export interface FundIndexInput {
  name: string;
  id: string;
  indexSymbol: string;
  indexName: string;
  candles: Candle[];
  historySymbol?: string;
  historyNote?: string;
  fundPrice: number | null;
  riskOff: boolean;
}

/** Full engine on the index candles; null with too little history for the engine. */
export function analyzeFundIndex(input: FundIndexInput): FundIndexView | null {
  const { indexSymbol, indexName, candles } = input;
  const analysis = analyzeStock(indexSymbol, indexName, candles, { symbol: indexSymbol }, NO_NEWS, null);
  if (!analysis) return null;
  const weekly = analyzeStock(indexSymbol, indexName, resampleWeekly(candles), { symbol: indexSymbol }, NO_NEWS, null);
  const horizon = buildHorizonInfo(analysis.score, weekly ? { score: weekly.score, recommendation: weekly.recommendation } : null, analyzeLongTerm(candles));
  const method = methodCheck(candles, null);
  horizon.method = method;
  const closes = candles.map((c) => c.close);
  const trigger = leverageTrigger(closes);
  const sma200 = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
  const leverage = leverageOf(input.name);
  const { action, reasons } = fundDecision({ recommendation: analysis.recommendation, combined: horizon.combined, method, trigger, leverage, riskOff: input.riskOff });
  return {
    name: input.name, id: input.id, indexSymbol, indexName,
    historySymbol: input.historySymbol ?? indexSymbol, historyNote: input.historyNote,
    leverage, market: marketOf(indexSymbol), fundPrice: input.fundPrice,
    analysis, horizon, method, trigger, sma200, action, reasons,
    fund: fundLevels(input.fundPrice, leverage, analysis),
  };
}
