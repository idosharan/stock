import type { AnalysisResult } from "./analysis.js";
import { PORTFOLIO, type HoldingDef } from "./config.js";
import { holdingSellAlerts, type ReportHtmlInput } from "./html.js";
import { selectDailyPick, type PickCandidate } from "./pick.js";
import { buildBriefActions } from "./brief.js";

export interface DataHealth {
  expected: number;
  analyzed: number;
  latestBarDates: Record<string, string | null>;
  missingSymbols: string[];
  failures: Record<string, string>;
  warnings: string[];
}

export interface HoldingSummary {
  name: string;
  symbol?: string;
  taseNumber?: string;
  entryPrice: number;
  price?: number;
  returnPct?: number;
  score?: number;
  scoreDelta?: number;
  sequenceStop?: number;
  stop?: number;
  coverage: "analyzed" | "price-only" | "missing";
  alerts: string[];
}

export interface ReportSummarySnapshot {
  version: 1;
  mode: ReportHtmlInput["mode"];
  generatedAt: string;
  portfolio: HoldingSummary[];
  dataHealth: DataHealth | null;
  health: string[];
  body: string;
  ranking: { order: string; rows: string[] };
  summary: string;
}

const plain = (value: string): string => value.replace(/<[^>]*>/g, " ")
  .replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const number = (value: number | null | undefined): string => finite(value) ? String(Number(value.toFixed(2))) : "לא זמין";
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${number(value)}`;
const reportDay = (date: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(date);

function healthLines(input: ReportHtmlInput): string[] {
  const health = input.dataHealth;
  const lines = ["זמן ההפקה אינו זמן הציטוט; המחירים אינם מוצגים כנתוני זמן אמת."];
  if (!input.results.length) lines.push("אין תוצאות ניתוח; אין דוח ניתוח תקין.");
  if (!health) {
    lines.push(`נותחו ${input.results.length} מניות; היקף האיסוף ותאריכי הנרות אינם מתועדים.`);
    return lines;
  }
  const partial = health.analyzed < health.expected || health.missingSymbols.length > 0 || Object.keys(health.failures).length > 0;
  lines.push(`${partial ? "איסוף חלקי" : "איסוף מניות לניתוח"}: ${health.analyzed} מתוך ${health.expected}.`);
  if (health.missingSymbols.length) lines.push(`ללא ניתוח: ${health.missingSymbols.map(plain).join(", ")}`);
  const dates = Object.entries(health.latestBarDates).sort(([left], [right]) => left.localeCompare(right));
  if (dates.some(([, date]) => date != null && date < reportDay(input.generatedAt))) {
    lines.push("נרות מתאריכים קודמים למועד ההפקה; הבדל קלנדרי עשוי לנבוע מימי מנוחה או חג ואינו מעיד לבדו על תקלה.");
  }
  for (const [symbol, date] of dates) lines.push(`${plain(symbol)}: נר יומי אחרון ${date ? plain(date) : "לא ידוע"}`);
  for (const [symbol, reason] of Object.entries(health.failures).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${plain(symbol)}: ${plain(reason)}`);
  }
  lines.push(...health.warnings.map(plain));
  return lines;
}

function holdingAlerts(holding: HoldingDef, result: AnalysisResult | undefined, price: number | undefined, input: ReportHtmlInput): string[] {
  const alerts: string[] = [];
  if (positive(price) && positive(holding.alertBelow) && price < holding.alertBelow) {
    alerts.push(`מחיר מתחת לרמת הבקרה ${number(holding.alertBelow)}`);
  }
  if (!result) return alerts;
  for (const signal of result.signals) {
    if (["שבירת רצף עולה", "קרוס דובי", "שבירת שפל"].some((criterion) => signal.includes(criterion))) alerts.push(plain(signal));
  }
  if (result.recommendation === "הימנעות / מכירה") alerts.push("המלצת המנוע: הימנעות / מכירה");
  if (finite(result.score) && result.score < 15) alerts.push(`ציון חלש ${number(result.score)}`);
  const horizon = input.horizons?.get(result.symbol);
  if (horizon && horizon.combined < 0) alerts.push(`ציון משולב שלילי ${number(horizon.combined)}`);
  if (horizon?.longTerm?.label === "שלילי" && !result.indicators.trendUp) alerts.push("מגמה ארוכה שלילית וחולשה בטווח הניתוח");
  if (result.divergence === "bearish") alerts.push("דיברגנס שלילי מול RSI");
  if (result.indicators.supertrendUp === false) alerts.push("Supertrend שלילי");
  if (result.patterns.some((pattern) => pattern.bias === "bearish")) alerts.push("תבנית נר דובית");
  if (positive(price) && positive(result.risk?.stop) && price < result.risk.stop) alerts.push(`מחיר מתחת לסטופ ${number(result.risk.stop)}`);
  if (positive(price) && positive(result.sequenceStop) && price < result.sequenceStop) alerts.push(`מחיר מתחת לסטופ הרצף ${number(result.sequenceStop)}`);
  if (input.newsByStock.get(result.symbol)?.freshNegative?.length) alerts.push("כותרת שלילית טרייה");
  if (positive(price) && positive(holding.entryPrice) && price / holding.entryPrice > 1.08
    && (result.indicators.stochK ?? 0) >= 90 && (result.indicators.rsi ?? 0) >= 68) alerts.push("רווח מעל 8% עם מתיחות קיצונית ב-RSI ובסטוכסטי");
  return [...new Set(alerts)];
}

function rankingLine(result: AnalysisResult, input: ReportHtmlInput): string {
  const horizon = input.horizons?.get(result.symbol);
  return [
    `${plain(result.name)} (${plain(result.symbol)})`, `מחיר ${number(result.price)}`,
    finite(result.score) ? `ציון ${number(result.score)}` : "אין ציון",
    ...(horizon ? [`שבועי ${number(horizon.weeklyScore)}`, `ארוך ${plain(horizon.longTerm?.label ?? "לא זמין")}`, `משולב ${number(horizon.combined)}`] : []),
    plain(result.recommendation),
  ].join(" | ");
}

function pickLine(candidate: PickCandidate, input: ReportHtmlInput): string {
  const risk = candidate.r.risk;
  return `${rankingLine(candidate.r, input)}${risk ? ` | סטופ ${number(risk.stop)} | יעד ${number(risk.target)} | סיכוי/סיכון ${number(risk.rr)}` : " | אין סטופ זמין"}`;
}

export function buildReportSummarySnapshot(input: ReportHtmlInput): ReportSummarySnapshot {
  const bySymbol = new Map(input.results.map((result) => [result.symbol, result]));
  const portfolio: HoldingSummary[] = PORTFOLIO.map((holding) => {
    const result = holding.symbol ? bySymbol.get(holding.symbol) : undefined;
    const price = result?.price ?? (holding.symbol ? input.extraPrices?.get(holding.symbol) : undefined) ?? input.extraPrices?.get(holding.name);
    const previous = holding.symbol ? input.prevScores?.get(holding.symbol) : undefined;
    return {
      name: plain(holding.name), symbol: holding.symbol, taseNumber: holding.taseNumber, entryPrice: holding.entryPrice,
      ...(positive(price) ? { price, ...(positive(holding.entryPrice) ? { returnPct: (price / holding.entryPrice - 1) * 100 } : {}) } : {}),
      ...(result && finite(result.score) ? { score: result.score, ...(finite(previous) ? { scoreDelta: result.score - previous } : {}) } : {}),
      ...(positive(result?.sequenceStop) ? { sequenceStop: result.sequenceStop } : {}),
      ...(positive(result?.risk?.stop) ? { stop: result.risk.stop } : {}),
      coverage: result ? "analyzed" : positive(price) ? "price-only" : "missing",
      alerts: holdingAlerts(holding, result, price, input),
    };
  });
  const health = healthLines(input);
  const lines = [`דוח ${input.mode === "daily" ? "יומי" : "שבועי"} | זמן הפקה: ${input.generatedAt.toISOString()}`,
    "", "===== בריאות הנתונים =====", ...health, "", "===== ספירת המלצות =====",
    `קנייה ${input.results.filter((result) => result.recommendation.startsWith("קנייה")).length} | החזקה ${input.results.filter((result) => result.recommendation === "החזקה").length} | מכירה / הימנעות ${input.results.filter((result) => result.recommendation === "הימנעות / מכירה").length}`,
    "", "===== התיק שלי ====="];
  for (const [index, holding] of portfolio.entries()) {
    const definition = PORTFOLIO[index];
    const parts = [`${holding.name} (${[holding.symbol, holding.taseNumber].filter(Boolean).join(" / ")})`,
      `כניסה ${number(holding.entryPrice)}`, `מחיר ${number(holding.price)}`,
      `יחידות: ${holding.symbol && !holding.symbol.endsWith(".TA") ? "דולר" : "אגורות"}`,
      `רווח/הפסד ${finite(holding.returnPct) ? `${signed(Number(holding.returnPct.toFixed(1)))}%` : "לא זמין"}`];
    if (finite(holding.score)) parts.push(`ציון ${number(holding.score)}${finite(holding.scoreDelta) ? ` | Δ ${signed(holding.scoreDelta)}` : " | Δ לא זמין"}`);
    if (holding.coverage === "analyzed") {
      parts.push(`סטופ רצף ${number(holding.sequenceStop)}`, `סטופ סיכון ${number(holding.stop)}`);
      const horizon = holding.symbol ? input.horizons?.get(holding.symbol) : undefined;
      if (horizon) parts.push(`שבועי ${number(horizon.weeklyScore)}`, `ארוך ${plain(horizon.longTerm?.label ?? "לא זמין")}`, `משולב ${number(horizon.combined)}`);
    } else {
      parts.push(`${holding.coverage === "price-only" ? "מחיר בלבד" : "מחיר חסר"}; ללא ניתוח טכני, אין ציון או סטופ; זמן הציטוט לא ידוע`);
    }
    if (definition.triggerIndex) {
      const benchmark = input.indices.find((entry) => entry.symbol === definition.triggerIndex);
      parts.push(`מדד ייחוס ${plain(definition.triggerIndex)}: ${benchmark ? `${plain(benchmark.stance)}; מגמת ממוצעים ${benchmark.indicators.trendUp ? "חיובית" : "לא חיובית"}` : "אין נתונים"}; אינו ניתוח של הקרן`);
    }
    lines.push(parts.join(" | "));
  }
  lines.push("", "===== התראות סיכון שמרניות =====", "כל דגל מוצג לבדיקה; אלו אינן דרגות החומרה של מקטע המכירה בדוח.");
  const alerts = portfolio.filter((holding) => holding.alerts.length);
  if (!alerts.length) lines.push("לא זוהו דגלי סיכון בנתונים הזמינים; אין בכך אישור שכל ההחזקות מעל סטופ או מכוסות בניתוח.");
  for (const holding of alerts) lines.push(`${holding.name} (${holding.symbol ?? holding.taseNumber}): ${holding.alerts.join(" | ")}`);
  if (portfolio.some((holding) => holding.coverage !== "analyzed")) lines.push("הכיסוי הטכני של התיק חלקי; החזקות ללא ניתוח אינן נבדקות ליציאה טכנית.");
  const pick = selectDailyPick(input.results, input.horizons, input.regime);
  lines.push("", "===== המלצת הרכישה =====", pick.main ? pickLine(pick.main, input) : "אין מועמדת שעברה את מסנני הבחירה עם הנתונים הזמינים.");
  for (const alternative of pick.alts) lines.push(`חלופה: ${pickLine(alternative, input)}`);
  if (pick.strengthen && !holdingSellAlerts(input.results, input.horizons, input.newsByStock).some(alert => alert.symbol === pick.strengthen?.r.symbol)) {
    lines.push(`חיזוק החזקה: ${pickLine(pick.strengthen, input)}`);
  }
  if (pick.regimeNote) lines.push(plain(pick.regimeNote));
  if (input.regime) lines.push(`מצב שוק: ${plain(input.regime.label)} | ציון ${number(input.regime.score)} | רוחב ${number(input.regime.breadthPct)}%`);
  lines.push("", "===== תחזית ומדדים =====", "תחזית היוריסטית, לא הסתברות מכוילת; הראיות ההיסטוריות ניסיוניות.", plain(input.forecast.summary));
  for (const market of input.forecast.markets) lines.push(`${plain(market.market)}: ${plain(market.direction)} | ציון ${number(market.score)} | ${plain(market.horizon)}`);
  for (const index of input.indices) lines.push(`${plain(index.name)} (${plain(index.symbol)}) | מחיר ${number(index.price)} | שינוי ${finite(index.changePct) ? `${signed(index.changePct)}%` : "לא זמין"} | ציון ${number(index.score)} | ${plain(index.stance)}`);
  if (!input.indices.length) lines.push("אין נתוני מדדים.");
  lines.push("הדוח אינו ייעוץ השקעות ואינו שולח הוראות מסחר.");
  const ranking = {
    order: input.horizons?.size ? "ציון משולב" : "ציון טכני",
    rows: [...input.results].sort((left, right) => (input.horizons?.get(right.symbol)?.combined ?? right.score) - (input.horizons?.get(left.symbol)?.combined ?? left.score))
      .map((result) => rankingLine(result, input)),
  };
  const actions = buildBriefActions(input);
  lines.push("", "===== סיכום החלטות לפי כללי המנוע =====",
    `קנייה / חיזוק: ${actions.buy.join(" | ") || "אין מועמדת"}`,
    `מכירה / צמצום לבדיקה: ${actions.sell.join(" | ") || "אין התראת יציאה או צמצום לפי הסף"}`,
    `החזקה / מעקב: ${actions.watch.join(" | ") || "אין החזקות שנותחו בקבוצה זו"}`,
    `ללא סיווג טכני: ${actions.missing.join(" | ") || "אין"}`,
    "התראות כלליות אינן המלצת מכירה; סיווגי הסעיף הזה משקפים את ספי החומרה בדוח.");
  const body = lines.join("\n");
  return {
    version: 1, mode: input.mode, generatedAt: input.generatedAt.toISOString(), portfolio,
    dataHealth: input.dataHealth ? structuredClone(input.dataHealth) : null, health, body, ranking,
    summary: `${body}${ranking.rows.length ? `\n\n===== 5 המובילות בטבלה — סדר ${ranking.order} =====\n${ranking.rows.slice(0, 5).join("\n")}` : ""}`,
  };
}

export function buildReportSummary(input: ReportHtmlInput): string {
  return buildReportSummarySnapshot(input).summary;
}