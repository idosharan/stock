/**
 * "האייג'נט" — מחולל תחזית שוק כתובה לבורסת תל אביב ולנאסד"ק.
 * במקום רק להציג מספרים, מודול זה מסנתז את כל הנתונים שנאספו (מדדים, מגמות
 * טכניות וסנטימנט החדשות) לכדי תחזית מילולית לתקופת הדוח: יומי = להיום,
 * שבועי = לשבוע הקרוב. זהו פלט אנליטי בסגנון תשובה של אנליסט.
 */
import type { IndexAnalysis, MarketStance } from "./indices.js";
import type { NewsItem } from "./news.js";
import type { Mode } from "./report.js";
import type { Candle } from "./data.js";

export interface HistoricalEvent {
  id: string;
  type: string;
  symbol: string;
  occurredAt: string;
  publishedAt: string;
  source: string;
}

export interface HistoricalHorizon {
  days: number;
  status: 'estimated' | 'insufficient';
  sampleCount: number;
  probabilityUp: number | null;
  probabilityInterval: [number, number] | null;
  medianReturn: number | null;
  p10: number | null;
  p90: number | null;
  baselineProbability: number | null;
  baselineReturn: number | null;
  excessReturn: number | null;
  analogDates: string[];
  reason: string | null;
}

export interface HistoricalForecast {
  symbol: string;
  asOf: string | null;
  regime: 'trend' | 'range' | 'stress' | 'unknown';
  horizons: HistoricalHorizon[];
  events: Array<{ type: string; sampleCount: number; medianReturn: number | null; probabilityUp: number | null }>;
  warnings: string[];
}

export interface HistoricalInput {
  symbol: string;
  candles: Candle[];
  benchmark?: Candle[];
  asOf?: Date;
  costBps?: number;
  events?: HistoricalEvent[];
}

const HISTORICAL_HORIZONS = [5, 10, 20];
const MIN_ANALOGS = 12;
const meanValue = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const location = (sorted.length - 1) * fraction;
  const lower = Math.floor(location);
  return sorted[lower] + (sorted[Math.ceil(location)] - sorted[lower]) * (location - lower);
}

export function validateEvents(value: unknown): HistoricalEvent[] {
  if (!Array.isArray(value)) throw new Error('Events must be an array');
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid event');
    for (const field of ['id', 'type', 'symbol', 'occurredAt', 'publishedAt', 'source']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`Invalid event ${field}`);
    }
    const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!/^https?:\/\//i.test(entry.source) || !timestamp.test(entry.occurredAt) || !timestamp.test(entry.publishedAt) || !Number.isFinite(Date.parse(entry.occurredAt)) || !Number.isFinite(Date.parse(entry.publishedAt))) {
      throw new Error('Event requires source URL and valid timestamps');
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate event ${entry.id}`);
    ids.add(entry.id);
    return { id: entry.id, type: entry.type, symbol: entry.symbol, occurredAt: entry.occurredAt, publishedAt: entry.publishedAt, source: entry.source };
  });
}

function cleanHistory(candles: Candle[], asOf: Date): Candle[] {
  const byDate = new Map<string, Candle>();
  const completedBefore = asOf.toISOString().slice(0, 10);
  for (const candle of candles) {
    if (!Number.isFinite(candle.date.getTime()) || candle.date > asOf) continue;
    if (candle.date.toISOString().slice(0, 10) >= completedBefore) continue;
    if (![candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0)) continue;
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) continue;
    byDate.set(candle.date.toISOString().slice(0, 10), candle);
  }
  return [...byDate.values()].sort((left, right) => left.date.getTime() - right.date.getTime());
}

function stateAt(candles: Candle[], index: number, benchmark: Map<string, number>) {
  if (index < 60) return null;
  const closes = candles.slice(index - 60, index + 1).map(candle => candle.close);
  const price = closes.at(-1)!;
  const short = meanValue(closes.slice(-20));
  const long = meanValue(closes.slice(-60));
  const dailyReturns = closes.slice(-21).slice(1).map((close, offset) => close / closes[closes.length - 21 + offset] - 1);
  const center = meanValue(dailyReturns);
  const volatility = Math.sqrt(meanValue(dailyReturns.map(value => (value - center) ** 2))) * Math.sqrt(252);
  const drawdown = price / Math.max(...closes) - 1;
  const regime: HistoricalForecast['regime'] = volatility > 0.35 || drawdown < -0.10 ? 'stress' : Math.abs(short / long - 1) > 0.02 ? 'trend' : 'range';
  const volume = meanValue(candles.slice(index - 19, index + 1).map(candle => Math.max(0, candle.volume || 0)));
  const dayKey = (offset: number) => candles[index - offset].date.toISOString().slice(0, 10);
  const benchmarkNow = benchmark.get(dayKey(0));
  const benchmarkBefore = benchmark.get(dayKey(20));
  const benchmarkReturn = benchmarkNow && benchmarkBefore ? benchmarkNow / benchmarkBefore - 1 : null;
  const momentum = price / closes[40] - 1;
  return {
    regime,
    features: [
      (price / closes[55] - 1) / 0.05,
      momentum / 0.10,
      (price / short - 1) / 0.05,
      volatility / 0.30,
      drawdown / 0.10,
      Math.min(4, volume > 0 ? candles[index].volume / volume : 1) / 2,
      ...(benchmarkReturn === null ? [] : [(momentum - benchmarkReturn) / 0.10]),
    ],
  };
}

function wilson(probability: number, count: number): [number, number] {
  const zSquared = 1.96 ** 2;
  const center = (probability + zSquared / (2 * count)) / (1 + zSquared / count);
  const radius = 1.96 * Math.sqrt(probability * (1 - probability) / count + zSquared / (4 * count * count)) / (1 + zSquared / count);
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

export function historicalForecast(input: HistoricalInput): HistoricalForecast {
  const asOf = input.asOf ?? new Date();
  const candles = cleanHistory(input.candles, asOf);
  const benchmark = new Map(cleanHistory(input.benchmark ?? [], asOf).map(candle => [candle.date.toISOString().slice(0, 10), candle.close]));
  const current = candles.length - 1;
  const state = stateAt(candles, current, benchmark);
  const cost = input.costBps ?? 20;
  if (!Number.isFinite(cost) || cost < 0) throw new Error('costBps must be finite and non-negative');
  const eligibleEvents = validateEvents(input.events ?? []).filter(event => event.symbol === input.symbol && Date.parse(event.publishedAt) <= asOf.getTime() && Date.parse(event.occurredAt) <= asOf.getTime());
  const forecast: HistoricalForecast = {
    symbol: input.symbol, asOf: candles.at(-1)?.date.toISOString() ?? null, regime: state?.regime ?? 'unknown', horizons: [], events: [],
    warnings: [
      'שכיחויות עבר ניסיוניות, לא הסתברויות מכוילות ולא הבטחת תשואה.',
      `כניסה בפתיחת המסחר הבאה; עלות הלוך ושוב ${cost} נקודות בסיס. טווח P10–P90 הוא פיזור תוצאות, לא רווח סמך לתחזית.`,
      'מדגם ממצב שוק דומה; תלות בזמן ושינויי משטר עלולים להקטין את אמינות האומדן.',
      'נתוני מחיר הספק אינם סדרת תשואה כוללת מאומתת; דיבידנדים ופעולות הון עלולים להשפיע.',
      'נכללים רק נרות מימים שהסתיימו ב־UTC; נר היום אינו נכלל גם לאחר סגירת הבורסה המקומית.',
    ],
  };
  if (!eligibleEvents.length) forecast.warnings.push('אין מאגר אירועים מתוארך זמין לנייר זה; רכיב האירועים לא השתתף בתחזית.');
  const outcome = (index: number, days: number) => (candles[index + days].close / candles[index + 1].open - 1) * 100 - cost / 100;
  for (const days of HISTORICAL_HORIZONS) {
    const candidates: Array<{ index: number; distance: number; result: number }> = [];
    const baseline: number[] = [];
    for (let index = 60; index + days < current; index++) {
      if ((index - 60) % (days + 1) === 0) baseline.push(outcome(index, days));
      const past = stateAt(candles, index, benchmark);
      if (!state || !past || past.regime !== state.regime || past.features.length !== state.features.length) continue;
      const distance = Math.sqrt(meanValue(past.features.map((feature, offset) => (feature - state.features[offset]) ** 2)));
      if (distance <= 1.25) candidates.push({ index, distance, result: outcome(index, days) });
    }
    candidates.sort((left, right) => left.distance - right.distance || left.index - right.index);
    const selected: typeof candidates = [];
    for (const candidate of candidates) {
      if (selected.every(other => Math.abs(candidate.index - other.index) > days)) selected.push(candidate);
      if (selected.length === 40) break;
    }
    const values = selected.map(candidate => candidate.result);
    const enough = values.length >= MIN_ANALOGS;
    const probability = enough ? values.filter(value => value > 0).length / values.length : null;
    const median = enough ? quantile(values, 0.5) : null;
    const baselineReturn = baseline.length ? meanValue(baseline) : null;
    forecast.horizons.push({
      days, status: enough ? 'estimated' : 'insufficient', sampleCount: values.length,
      probabilityUp: probability, probabilityInterval: probability === null ? null : wilson(probability, values.length),
      medianReturn: median, p10: enough ? quantile(values, 0.1) : null, p90: enough ? quantile(values, 0.9) : null,
      baselineProbability: baseline.length ? baseline.filter(value => value > 0).length / baseline.length : null,
      baselineReturn, excessReturn: enough && baselineReturn !== null ? meanValue(values) - baselineReturn : null,
      analogDates: selected.map(candidate => candles[candidate.index].date.toISOString().slice(0, 10)).sort(),
      reason: enough ? null : `נמצאו ${values.length} מקרים לא חופפים; נדרשים לפחות ${MIN_ANALOGS}.`,
    });
  }
  for (const type of new Set(eligibleEvents.map(event => event.type))) {
    const dates: number[] = [];
    for (const event of eligibleEvents.filter(entry => entry.type === type).sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt))) {
      const available = Math.max(Date.parse(event.publishedAt), Date.parse(event.occurredAt));
      const entryIndex = candles.findIndex(candle => candle.date.getTime() > available);
      if (entryIndex < 1 || entryIndex + 9 >= current || dates.some(previous => Math.abs(previous - entryIndex) < 10)) continue;
      dates.push(entryIndex);
    }
    const values = dates.map(index => (candles[index + 9].close / candles[index].open - 1) * 100 - cost / 100);
    forecast.events.push({ type, sampleCount: values.length, medianReturn: values.length >= MIN_ANALOGS ? quantile(values, 0.5) : null, probabilityUp: values.length >= MIN_ANALOGS ? values.filter(value => value > 0).length / values.length : null });
  }
  return forecast;
}

export interface HistoricalValidation {
  days: number;
  tested: number;
  estimated: number;
  brier: number | null;
  baselineBrier: number | null;
  meanReturn: number | null;
  selectedReturn: number | null;
  selectedCount: number;
  calibration: Array<{ band: string; count: number; predicted: number | null; observed: number | null }>;
}

export function validateHistoricalForecast(input: HistoricalInput, evaluationDays = 120): HistoricalValidation[] {
  const candles = cleanHistory(input.candles, input.asOf ?? new Date());
  return HISTORICAL_HORIZONS.map(days => {
    const rows: Array<{ probability: number; baseline: number; actual: number; net: number }> = [];
    let tested = 0;
    for (let index = Math.max(120, candles.length - evaluationDays - days); index + days < candles.length; index += days + 1) {
      tested++;
      const cutoff = new Date(`${candles[index].date.toISOString().slice(0, 10)}T00:00:00.000Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() + 1);
      const estimate = historicalForecast({ ...input, candles, asOf: cutoff }).horizons.find(horizon => horizon.days === days)!;
      if (estimate.probabilityUp === null || estimate.baselineProbability === null) continue;
      const net = (candles[index + days].close / candles[index + 1].open - 1) * 100 - (input.costBps ?? 20) / 100;
      rows.push({ probability: estimate.probabilityUp, baseline: estimate.baselineProbability, actual: net > 0 ? 1 : 0, net });
    }
    const selected = rows.filter(row => row.probability >= 0.6);
    return {
      days, tested, estimated: rows.length,
      brier: rows.length ? meanValue(rows.map(row => (row.probability - row.actual) ** 2)) : null,
      baselineBrier: rows.length ? meanValue(rows.map(row => (row.baseline - row.actual) ** 2)) : null,
      meanReturn: rows.length ? meanValue(rows.map(row => row.net)) : null,
      selectedReturn: selected.length ? meanValue(selected.map(row => row.net)) : null,
      selectedCount: selected.length,
      calibration: [[0, 0.4], [0.4, 0.6], [0.6, 1.01]].map(([lower, upper]) => {
        const group = rows.filter(row => row.probability >= lower && row.probability < upper);
        return { band: `${Math.round(lower * 100)}-${Math.min(100, Math.round(upper * 100))}%`, count: group.length, predicted: group.length ? meanValue(group.map(row => row.probability)) : null, observed: group.length ? meanValue(group.map(row => row.actual)) : null };
      }),
    };
  });
}

export type ForecastDirection =
  | "עלייה"
  | "נטייה לעלייה"
  | "יציבות / דשדוש"
  | "נטייה לירידה"
  | "ירידה";

export interface MarketForecast {
  /** שם השוק, למשל "בורסת תל אביב" או "נאסד\"ק". */
  market: string;
  icon: string;
  direction: ForecastDirection;
  /** טווח התחזית: "היום" או "השבוע הקרוב". */
  horizon: string;
  /** ציון מצרפי משוקלל של המדדים הרלוונטיים. */
  score: number;
  /** פסקאות הנימוק של התחזית. */
  reasoning: string[];
  /** גורמים מרכזיים לעקוב אחריהם. */
  watchpoints: string[];
}

export interface ForecastResult {
  horizon: string;
  /** סיכום-על כללי של מצב הרוח בשווקים. */
  summary: string;
  markets: MarketForecast[];
  /** סיכום סנטימנט החדשות שנסרקו. */
  newsTone: { positive: number; negative: number; neutral: number; label: string };
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** ממיר ציון מצרפי לכיוון תחזית. */
function scoreToDirection(score: number): ForecastDirection {
  if (score >= 30) return "עלייה";
  if (score >= 10) return "נטייה לעלייה";
  if (score > -10) return "יציבות / דשדוש";
  if (score > -30) return "נטייה לירידה";
  return "ירידה";
}

function stanceLabel(stance: MarketStance): string {
  return stance;
}

/** מנסח פסקת נימוק עבור קבוצת מדדים של שוק מסוים. */
function reasonFor(indices: IndexAnalysis[], horizon: string): string[] {
  const reasoning: string[] = [];
  for (const idx of indices) {
    const chg =
      idx.changePct != null
        ? `${idx.changePct >= 0 ? "+" : ""}${idx.changePct.toFixed(2)}%`
        : "—";
    const topSignal = idx.signals[0] ? ` ${idx.signals[0]}` : "";
    reasoning.push(
      `${idx.name} (${idx.symbol}) — מצב "${stanceLabel(idx.stance)}", שינוי אחרון ${chg}, ציון טכני ${idx.score}.${topSignal}`
    );
  }
  return reasoning;
}

/** בונה watchpoints כלליים לפי כיוון התחזית והטווח. */
function buildWatchpoints(direction: ForecastDirection, vix: IndexAnalysis | undefined): string[] {
  const points: string[] = [];
  if (vix) {
    const lvl = vix.price;
    if (lvl >= 25)
      points.push(`מדד הפחד VIX גבוה (${lvl.toFixed(1)}) — תנודתיות מוגברת וסיכון לתזוזות חדות.`);
    else if (lvl <= 15)
      points.push(`מדד הפחד VIX נמוך (${lvl.toFixed(1)}) — תנודתיות גלומה נמוכה; אין בכך הגנה מפני זעזועים.`);
    else
      points.push(`מדד הפחד VIX ברמה בינונית (${lvl.toFixed(1)}).`);
  }
  if (direction === "עלייה" || direction === "נטייה לעלייה")
    points.push("שמירה על רמות תמיכה ומומנטום חיובי — המשך עליות מותנה בנפח מסחר תומך.");
  else if (direction === "ירידה" || direction === "נטייה לירידה")
    points.push("בדיקת רמות תמיכה קריטיות — שבירה כלפי מטה עלולה להאיץ מימושים.");
  else
    points.push("היעדר כיוון ברור — סביר דשדוש בטווח עד לזרז (נתון מאקרו / דוחות).");
  return points;
}

/** מסכם את סנטימנט החדשות שנסרקו. */
function summarizeNews(allNews: NewsItem[]): ForecastResult["newsTone"] {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const n of allNews) {
    if (n.sentiment > 0) positive++;
    else if (n.sentiment < 0) negative++;
    else neutral++;
  }
  const net = positive - negative;
  let label: string;
  if (net >= 5) label = "סנטימנט חדשות חיובי בולט";
  else if (net >= 2) label = "סנטימנט חדשות חיובי מתון";
  else if (net <= -5) label = "סנטימנט חדשות שלילי בולט";
  else if (net <= -2) label = "סנטימנט חדשות שלילי מתון";
  else label = "סנטימנט חדשות מעורב / ניטרלי";
  return { positive, negative, neutral, label };
}

/**
 * מחולל התחזית המרכזי. מקבל את מצב המדדים, החדשות ומצב הדוח (יומי/שבועי)
 * ומחזיר תחזית כתובה לבורסת ת"א ולנאסד"ק.
 */
export function generateForecast(
  mode: Mode,
  indices: IndexAnalysis[],
  allNews: NewsItem[]
): ForecastResult {
  const horizon = mode === "daily" ? "היום" : "השבוע הקרוב";

  const findAll = (symbols: string[]) =>
    indices.filter((i) => symbols.includes(i.symbol));

  const taIndices = findAll(["TA35.TA", "TA90.TA"]);
  const nasdaqIndices = findAll(["^IXIC", "^NDX"]);
  const vix = indices.find((i) => i.symbol === "^VIX");

  const newsTone = summarizeNews(allNews);
  // הטיית סנטימנט החדשות נספרת לשוק הישראלי (החדשות הן מהעיתונות הכלכלית בארץ).
  const newsBias = Math.max(-12, Math.min(12, (newsTone.positive - newsTone.negative) * 2));

  const markets: MarketForecast[] = [];

  if (taIndices.length) {
    const baseScore = avg(taIndices.map((i) => i.score));
    const score = Math.round(baseScore + newsBias);
    const direction = scoreToDirection(score);
    const reasoning = reasonFor(taIndices, horizon);
    reasoning.push(
      `סנטימנט החדשות מהעיתונות הכלכלית הישראלית: ${newsTone.label} (${newsTone.positive} חיוביות, ${newsTone.negative} שליליות).`
    );
    markets.push({
      market: 'בורסת תל אביב',
      icon: "🇮🇱",
      direction,
      horizon,
      score,
      reasoning,
      watchpoints: buildWatchpoints(direction, vix),
    });
  }

  if (nasdaqIndices.length) {
    const score = Math.round(avg(nasdaqIndices.map((i) => i.score)));
    const direction = scoreToDirection(score);
    const reasoning = reasonFor(nasdaqIndices, horizon);
    markets.push({
      market: 'נאסד"ק',
      icon: "🇺🇸",
      direction,
      horizon,
      score,
      reasoning,
      watchpoints: buildWatchpoints(direction, vix),
    });
  }

  // סיכום-על
  const upCount = markets.filter(
    (m) => m.direction === "עלייה" || m.direction === "נטייה לעלייה"
  ).length;
  const downCount = markets.filter(
    (m) => m.direction === "ירידה" || m.direction === "נטייה לירידה"
  ).length;
  let summary: string;
  if (upCount && !downCount)
    summary = `התמונה הכוללת ${horizon} נוטה חיובית — המדדים המרכזיים מציגים חוזק טכני.`;
  else if (downCount && !upCount)
    summary = `התמונה הכוללת ${horizon} נוטה שלילית — חולשה טכנית במדדים המרכזיים, מומלצת זהירות.`;
  else if (upCount && downCount)
    summary = `תמונה מעורבת ${horizon} — שונות בין השווקים; יש לבחון כל שוק בנפרד.`;
  else
    summary = `סביבה ניטרלית ${horizon} — היעדר כיוון מובהק, סביר דשדוש עד להופעת זרז.`;

  return { horizon, summary, markets, newsTone };
}
