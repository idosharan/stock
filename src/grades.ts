/**
 * Evidence grades A–F in the style of multi-factor rating services: estimate revisions (Zacks),
 * earnings surprise / post-earnings drift (Bernard-Thomas), quality (Novy-Marx; AQR QMJ), value,
 * plus the already validated momentum and low-volatility factors. Fundamentals are current snapshots,
 * so grades are displayed and tracked forward; they join the ranking only after forward validation.
 */
import type { Candle } from "./data.js";
import { percentileRanks, type FactorScore } from "./engine.js";
import type { CrowdData, Fundamentals } from "./fundamentals.js";
import { pearson } from "./indicators.js";

export type GradeKey = "momentum" | "revisions" | "surprise" | "quality" | "value" | "risk" | "consensus" | "demand";
export type Letter = "A" | "B" | "C" | "D" | "F";

export const GRADE_KEYS: GradeKey[] = ["momentum", "revisions", "surprise", "quality", "value", "risk", "consensus", "demand"];
export const GRADE_LABELS: Record<GradeKey, string> = {
  momentum: "מומנטום", revisions: "רוויזיות", surprise: "הפתעות", quality: "איכות", value: "שווי", risk: "סיכון",
  consensus: "קונצנזוס", demand: "ביקוש",
};

export interface EvidenceGrades {
  pct: Record<GradeKey, number | null>;
  letters: Record<GradeKey, Letter | null>;
  redFlags: string[];
}

export interface GradeEntry {
  symbol: string;
  f: Fundamentals | null;
  factor?: FactorScore;
  /** Banks, insurers and non-bank lenders: leverage and EBITDA are not meaningful. */
  financial: boolean;
  /** Sector peers for quality/value (Seeking Alpha grades against the sector, not the whole market). */
  sector?: string;
  /** Last price, for the upside to the analysts' mean target. */
  price?: number;
  /** Up-day / down-day volume over 13 weeks (IBD accumulation/distribution). */
  accumulation?: number | null;
}

export function letterOf(pct: number): Letter {
  return pct >= 80 ? "A" : pct >= 60 ? "B" : pct >= 40 ? "C" : pct >= 20 ? "D" : "F";
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
/** A single analyst's estimate change is noise, not a consensus revision. */
const MIN_ANALYSTS = 2;
/** Consensus, targets and stars need a real crowd of analysts. */
const MIN_CROWD = 3;
/** Sector-relative grading needs enough peers; smaller sectors use the whole universe. */
const MIN_SECTOR_PEERS = 5;
const SECTOR_RELATIVE: GradeKey[] = ["quality", "value"];
const change = (now: number | null, then: number | null): number | null =>
  now != null && then != null && then !== 0 ? (now - then) / Math.abs(then) : null;
const inverse = (v: number | null): number | null => (v != null && v > 0 ? 1 / v : null);
const net = (up: number | null | undefined, down: number | null | undefined, min = 1): number | null =>
  up != null && down != null && up + down >= min ? (up - down) / (up + down) : null;

type Inputs = Array<number | null>;

function crowdInputs(c: CrowdData | null | undefined, price: number | undefined): Inputs {
  if (!c) return [];
  const analystInputs = (c.analysts ?? 0) >= MIN_CROWD
    ? [
      c.buyPct,
      c.buyPct != null && c.buyPct3m != null ? c.buyPct - c.buyPct3m : null,
      c.targetMean != null && price != null && price > 0 ? c.targetMean / price - 1 : null,
      net(c.targetRaises90, c.targetCuts90),
      net(c.upgrades90, c.downgrades90),
    ]
    : [];
  // insider sales are mostly compensation; only a meaningful sample counts
  return [...analystInputs, net(c.insiderBuys, c.insiderSells, 3)];
}

function gradeInputs(e: GradeEntry): Record<GradeKey, Inputs> {
  const f = e.f;
  const p = e.factor?.parts;
  const covered = (f?.epsAnalysts ?? 0) >= MIN_ANALYSTS;
  const up = covered ? f?.revisionsUp30 ?? null : null;
  const down = covered ? f?.revisionsDown30 ?? null : null;
  const s = f?.surprises ?? [];
  const acc = e.accumulation != null && Number.isFinite(e.accumulation) ? e.accumulation : null;
  return {
    // momentum/high52/trend are already universe percentiles from the validated factor engine
    momentum: p ? [p.momentum, p.high52, p.trend] : [],
    risk: p ? [p.lowVol, p.lowVol] : [],
    revisions: covered
      ? [change(f?.epsCurrent ?? null, f?.eps30dAgo ?? null), change(f?.epsCurrent ?? null, f?.eps90dAgo ?? null), net(up, down),
        change(f?.epsNextCurrent ?? null, f?.epsNext30dAgo ?? null), change(f?.epsNextCurrent ?? null, f?.epsNext90dAgo ?? null)]
      : [],
    surprise: [s.length >= 2 ? mean(s) : null, s.length ? s[s.length - 1] : null],
    quality: [
      f?.returnOnEquity ?? null,
      f?.returnOnAssets ?? null,
      e.financial && f?.grossMargins === 0 ? null : f?.grossMargins ?? null,
      f?.profitMargins ?? null,
      e.financial || f?.debtToEquity == null ? null : -f.debtToEquity,
    ],
    value: [
      inverse(f?.forwardPE ?? null) ?? inverse(f?.trailingPE ?? null),
      e.financial ? null : inverse(f?.evToEbitda ?? null),
      inverse(f?.priceToBook ?? null),
    ],
    consensus: crowdInputs(f?.crowd, e.price),
    demand: acc != null ? [acc, acc] : [],
  };
}

export function redFlags(f: Fundamentals | null, financial: boolean): string[] {
  if (!f) return [];
  const flags: string[] = [];
  const cut = (f.epsAnalysts ?? 0) >= MIN_ANALYSTS ? change(f.epsCurrent, f.eps90dAgo) : null;
  if (cut != null && cut <= -0.1 && (f.revisionsDown30 ?? 0) > (f.revisionsUp30 ?? 0)) {
    flags.push(`תחזית הרווח ירדה ${Math.round(-cut * 100)}% ב-90 יום והורדות התחזית רבות מההעלאות`);
  }
  const last2 = f.surprises.slice(-2);
  if (last2.length === 2 && last2.every((s) => s <= -0.05)) {
    flags.push(`שתי הפתעות שליליות אחרונות בדוחות (${last2.map((s) => `${Math.round(s * 100)}%`).join(", ")})`);
  }
  if (!financial && f.debtToEquity != null && f.debtToEquity > 300 && f.freeCashflow != null && f.freeCashflow < 0) {
    flags.push(`מינוף גבוה (חוב/הון ${Math.round(f.debtToEquity)}%) עם תזרים חופשי שלילי`);
  }
  if (f.shortPercentFloat != null && f.shortPercentFloat > 0.2) {
    flags.push(`שורט ${Math.round(f.shortPercentFloat * 100)}% מהמניות הצפות`);
  }
  return flags;
}

export function gradeUniverse(entries: GradeEntry[]): Map<string, EvidenceGrades> {
  const inputs = entries.map(gradeInputs);
  const pctByKey = {} as Record<GradeKey, Array<number | null>>;
  for (const key of GRADE_KEYS) {
    const width = Math.max(0, ...inputs.map((x) => x[key].length));
    const columns = Array.from({ length: width }, (_, c) =>
      key === "momentum" || key === "risk" ? inputs.map((x) => x[key][c] ?? null) : percentileRanks(inputs.map((x) => x[key][c] ?? null))
    );
    const composites = entries.map((_, i) => {
      const present = columns.map((col) => col[i]).filter((v): v is number => v != null && Number.isFinite(v));
      return present.length >= 2 ? mean(present) : null;
    });
    const universe = percentileRanks(composites);
    if (SECTOR_RELATIVE.includes(key)) {
      const bySector = new Map<string, number[]>();
      entries.forEach((e, i) => {
        if (e.sector && composites[i] != null) bySector.set(e.sector, [...(bySector.get(e.sector) ?? []), i]);
      });
      for (const members of bySector.values()) {
        if (members.length < MIN_SECTOR_PEERS) continue;
        const within = percentileRanks(members.map((i) => composites[i]));
        members.forEach((i, k) => { universe[i] = within[k]; });
      }
    }
    pctByKey[key] = universe;
  }
  return new Map(entries.map((e, i) => {
    const pct = Object.fromEntries(GRADE_KEYS.map((k) => [k, pctByKey[k][i] == null ? null : Math.round(pctByKey[k][i]!)])) as Record<GradeKey, number | null>;
    const letters = Object.fromEntries(GRADE_KEYS.map((k) => [k, pct[k] == null ? null : letterOf(pct[k]!)])) as Record<GradeKey, Letter | null>;
    return [e.symbol, { pct, letters, redFlags: redFlags(e.f, e.financial) }];
  }));
}

export function gradeChips(g: EvidenceGrades): string {
  return GRADE_KEYS.map((k) => `${GRADE_LABELS[k]} ${g.letters[k] ?? "—"}`).join(" · ");
}

export type Uncertainty = "נמוכה" | "בינונית" | "גבוהה" | "גבוהה מאוד";
export interface StarRating {
  stars: 1 | 2 | 3 | 4 | 5;
  /** Price / analysts' mean target (the fair-value proxy). */
  ratio: number;
  fairValue: number;
  uncertainty: Uncertainty;
}

/** Price/fair-value cut-offs for 5, 4, 3 and 2 stars; wider when the targets disagree more. */
const STAR_BANDS: Array<{ maxDispersion: number; label: Uncertainty; cuts: [number, number, number, number] }> = [
  { maxDispersion: 0.4, label: "נמוכה", cuts: [0.8, 0.95, 1.05, 1.25] },
  { maxDispersion: 0.8, label: "בינונית", cuts: [0.7, 0.9, 1.1, 1.35] },
  { maxDispersion: 1.2, label: "גבוהה", cuts: [0.6, 0.85, 1.15, 1.55] },
  { maxDispersion: Infinity, label: "גבוהה מאוד", cuts: [0.5, 0.8, 1.2, 1.75] },
];

/** Stars in the style of Morningstar: analysts' mean target as fair value, margin of safety by target dispersion. */
export function starRating(price: number, c: CrowdData | null | undefined): StarRating | null {
  if (!c || (c.analysts ?? 0) < MIN_CROWD || !(price > 0) || !(c.targetMean != null && c.targetMean > 0)) return null;
  const dispersion = c.targetHigh != null && c.targetLow != null ? (c.targetHigh - c.targetLow) / c.targetMean : 0.6;
  const band = STAR_BANDS.find((b) => dispersion < b.maxDispersion)!;
  const ratio = price / c.targetMean;
  const idx = band.cuts.findIndex((cut) => ratio <= cut);
  const stars = (idx < 0 ? 1 : 5 - idx) as StarRating["stars"];
  return { stars, ratio, fairValue: c.targetMean, uncertainty: band.label };
}

export function gradeWhy(g: EvidenceGrades): string {
  const graded = GRADE_KEYS.filter((k) => g.pct[k] != null);
  const strong = [...graded].filter((k) => g.pct[k]! >= 60).sort((a, b) => g.pct[b]! - g.pct[a]!).slice(0, 2);
  const weak = [...graded].filter((k) => g.pct[k]! < 40).sort((a, b) => g.pct[a]! - g.pct[b]!).slice(0, 1);
  const part = (keys: GradeKey[]) => keys.map((k) => `${GRADE_LABELS[k]} (${g.letters[k]})`).join(", ");
  return [
    strong.length ? `חזק: ${part(strong)}` : "",
    weak.length ? `חלש: ${part(weak)}` : "",
    g.redFlags.length ? `דגלים: ${g.redFlags.join("; ")}` : "",
  ].filter(Boolean).join(" · ");
}

/* ----------------------------- forward validation ----------------------------- */

/** date → symbol → grade percentile, stored daily in reports/state.sqlite ("grade-history"). */
export type GradeHistory = Record<string, Record<string, Partial<Record<GradeKey, number>>>>;

export interface GradeStats {
  ic: number | null;
  t: number | null;
  dates: number;
  passed: boolean;
}

export interface GradeValidation {
  version: 1;
  generatedAt: string;
  dates: number;
  minDates: number;
  grades: Record<GradeKey, GradeStats>;
}

export const GRADE_MIN_DATES = 40;
const GRADE_MIN_SYMBOLS = 10;
const GRADE_MIN_IC = 0.03;
const GRADE_MIN_T = 2;

export function appendGradeHistory(
  history: GradeHistory, date: string, entry: Record<string, Partial<Record<GradeKey, number>>>, limit = 250
): GradeHistory {
  const merged = { ...history, [date]: entry };
  return Object.fromEntries(Object.keys(merged).sort().slice(-limit).map((d) => [d, merged[d]]));
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Next-session open → close of the `horizon`-th session after the grading date. */
function forwardReturn(candles: Candle[], date: string, horizon: number): number | null {
  const i = candles.findIndex((c) => isoDay(c.date) > date);
  if (i < 0 || i + horizon - 1 >= candles.length) return null;
  const entry = candles[i].open > 0 ? candles[i].open : candles[i].close;
  const exit = candles[i + horizon - 1].close;
  return entry > 0 && exit > 0 ? exit / entry - 1 : null;
}

export function evaluateGradeHistory(history: GradeHistory, candles: Map<string, Candle[]>, horizon = 20): GradeValidation {
  const dates = Object.keys(history).sort();
  const ics = Object.fromEntries(GRADE_KEYS.map((k) => [k, [] as number[]])) as Record<GradeKey, number[]>;
  const used = new Set<string>();
  for (const date of dates) {
    const rows = Object.entries(history[date]).flatMap(([symbol, pct]) => {
      const series = candles.get(symbol);
      const ret = series ? forwardReturn(series, date, horizon) : null;
      return ret == null ? [] : [{ pct, ret }];
    });
    for (const key of GRADE_KEYS) {
      const pairs = rows.filter((r) => r.pct[key] != null);
      if (pairs.length < GRADE_MIN_SYMBOLS) continue;
      const ic = pearson(
        percentileRanks(pairs.map((p) => p.pct[key]!)) as number[],
        percentileRanks(pairs.map((p) => p.ret)) as number[]
      );
      if (ic == null) continue;
      ics[key].push(ic);
      used.add(date);
    }
  }
  // Daily grading dates with 20-session returns overlap; shrink t by sqrt(horizon / spacing).
  const usedDates = [...used].sort();
  const spanDays = usedDates.length > 1 ? (Date.parse(usedDates.at(-1)!) - Date.parse(usedDates[0])) / 86_400_000 : 0;
  const spacingSessions = usedDates.length > 1 ? Math.max(1, ((spanDays / (usedDates.length - 1)) * 5) / 7) : horizon;
  const overlap = Math.max(1, horizon / spacingSessions);
  const grades = Object.fromEntries(GRADE_KEYS.map((key) => {
    const xs = ics[key];
    if (!xs.length) return [key, { ic: null, t: null, dates: 0, passed: false }];
    const m = mean(xs);
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0;
    const rawT = sd > 0 ? m / (sd / Math.sqrt(xs.length)) : m > 0 ? 99 : m < 0 ? -99 : 0;
    const t = rawT / Math.sqrt(overlap);
    return [key, { ic: m, t, dates: xs.length, passed: xs.length >= GRADE_MIN_DATES && m >= GRADE_MIN_IC && t >= GRADE_MIN_T }];
  })) as Record<GradeKey, GradeStats>;
  return { version: 1, generatedAt: new Date().toISOString(), dates: used.size, minDates: GRADE_MIN_DATES, grades };
}

export function describeGradeValidation(v: GradeValidation | null | undefined, inRanking: readonly string[]): string {
  if (!v || v.dates === 0) return "ציוני ראיות: בבדיקה קדימה — טרם נאספו נתונים; מוצגים בלבד.";
  if (v.dates < v.minDates) return `ציוני ראיות: בבדיקה קדימה: ${v.dates}/${v.minDates} תאריכים; מוצגים בלבד.`;
  const parts = GRADE_KEYS.flatMap((k) => {
    const s = v.grades[k];
    return s.ic == null ? [] : [`${GRADE_LABELS[k]} IC ${s.ic.toFixed(2)} (t ${s.t!.toFixed(1)}) ${s.passed ? "עבר" : "לא עבר"}`];
  });
  const ranking = inRanking.length
    ? `בדירוג: ${inRanking.map((k) => GRADE_LABELS[k as GradeKey] ?? k).join(", ")}`
    : "מוצגים בלבד עד אישור";
  return `ציוני ראיות (${v.dates} תאריכים): ${parts.join(" · ")} · ${ranking}.`;
}
