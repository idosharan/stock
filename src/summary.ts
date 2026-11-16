import type { AnalysisResult, HorizonInfo } from "./analysis.js";
import { PORTFOLIO, GRADES_IN_RANKING, type HoldingDef } from "./config.js";
import { holdingSellAlerts, type ReportHtmlInput } from "./html.js";
import { selectDailyPick, METHOD_REJECT_PREFIX, type PickCandidate } from "./pick.js";
import { buildBriefActions, marketRecommendations } from "./brief.js";
import { describeEngine, underlyingText } from "./engine.js";
import { describeGradeValidation, gradeChips, starRating } from "./grades.js";
import { SETUP_LABEL } from "./indicators.js";
import { METHOD_RULES, methodPassLine, type CreatorRow } from "./news.js";

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
  entryPrice?: number;
  /** החזקת ליבה קבועה — התראות מוצגות לבחינה בלבד, לא כהמלצת מכירה. */
  core?: boolean;
  price?: number;
  quotedAt?: string;
  returnPct?: number;
  score?: number;
  scoreDelta?: number;
  sequenceStop?: number;
  stop?: number;
  coverage: "analyzed" | "price-only" | "missing";
  /** מצב מדד הייחוס לקרנות ללא ניתוח — המדד עצמו, לא הקרן. */
  referenceIndex?: { symbol: string; name: string; stance: string; trendUp: boolean; score?: number; changePct?: number };
  /** Fund analysed through its index: the action and the fund-equivalent stop. */
  indexView?: { index: string; action: string; recommendation: string; combined: number; fundStop?: number };
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

/** When a price was quoted: ISO timestamp, or "YYYY-MM-DD[ HH:MM]" in Israel time. */
export interface QuoteStamp {
  at: string;
  source: string;
}

/** Short Hebrew label for a quote time; `today` only when a same-day trade time is known. */
export function describeQuoteStamp(stamp: QuoteStamp | undefined, generatedAt: Date): { label: string; when: string; source: string; today: boolean } | null {
  if (!stamp) return null;
  let day: string;
  let time: string | null;
  if (stamp.at.includes("T")) {
    const date = new Date(stamp.at);
    if (!Number.isFinite(date.getTime())) return null;
    day = reportDay(date);
    time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  } else {
    const match = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/.exec(stamp.at);
    if (!match) return null;
    day = match[1];
    time = match[2] ?? null;
  }
  const today = day === reportDay(generatedAt) && time != null;
  const [, month, dayOfMonth] = day.split("-");
  const date = day === reportDay(generatedAt) ? "היום" : `${Number(dayOfMonth)}.${Number(month)}`;
  const when = `${date}${time ? ` ${time}` : ""}`;
  const source = plain(stamp.source);
  return { label: `${when} · ${source}`, when, source, today };
}

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
  const underlying = input.macro?.underlying?.find((u) => u.taseNumber === holding.taseNumber);
  if (underlying?.hit) alerts.push(plain(underlyingText(underlying)));
  const fund = !result ? input.fundViews?.find((v) => v.name === holding.name) : undefined;
  if (fund?.action === "צמצום / מכירה") alerts.push(`לפי ${plain(fund.indexName)}: ${plain(fund.reasons[0] ?? fund.action)}`);
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
    ...(horizon?.factor ? [`פקטורים ${number(horizon.factor.score)} (דירוג ${number(horizon.factor.rank)})`] : []),
    ...(horizon?.grades ? [`ציונים: ${gradeChips(horizon.grades)}`] : []),
    ...(horizon?.grades?.redFlags.length ? [`דגלים: ${horizon.grades.redFlags.map(plain).join("; ")}`] : []),
    ...(horizon?.waitForConfirmation ? ["להמתין לאישור"] : []),
    plain(result.recommendation),
  ].join(" | ");
}

function pickLine(candidate: PickCandidate, input: ReportHtmlInput): string {
  const risk = candidate.r.risk;
  const stars = starRating(candidate.r.price, candidate.hz.crowd);
  const extras = [
    ...(finite(candidate.hz.rs) ? [`RS ${candidate.hz.rs}`] : []),
    ...(stars ? [`${starText(stars.stars)} (אי-ודאות ${stars.uncertainty})`] : []),
    ...(candidate.hz.extended ? [`מתוח ${number(Number(candidate.hz.extended.pct.toFixed(1)))}% מעל נקודת הפריצה — לא לרדוף (IBD)`] : []),
    ...(candidate.hz.method ? [`כללי מיכה סטוקס: עברה — ${plain(methodPassLine(candidate.hz.method))}`] : []),
  ];
  return `${rankingLine(candidate.r, input)}${extras.length ? ` | ${extras.join(" | ")}` : ""}${risk ? ` | סטופ ${number(risk.stop)} | יעד ${number(risk.target)} | סיכוי/סיכון ${number(risk.rr)}` : " | אין סטופ זמין"}`;
}

export const starText = (n: number): string => "★".repeat(n) + "☆".repeat(5 - n);
const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** Plain-text lines for a core holding: technicals, grades, crowd wisdom, top-up zone and review levels. */
export function coreHoldingLines(holding: HoldingDef, result: AnalysisResult | undefined, horizon: HorizonInfo | undefined): string[] {
  if (!result) return ["אין ניתוח בהרצה זו (נתונים חסרים); ההחזקה נשארת קבועה."];
  const units = result.symbol.endsWith(".TA") ? "אג'" : "$";
  const lines = [
    `מחיר ${number(result.price)} ${units} | ${positive(holding.entryPrice) ? `רווח/הפסד ${signed(Number(((result.price / holding.entryPrice - 1) * 100).toFixed(1)))}% מול כניסה ${number(holding.entryPrice)}` : "אין מחיר עלות"}`,
    [`טכני: יומי ${number(result.score)}`, ...(horizon ? [`שבועי ${number(horizon.weeklyScore)}`, `ארוך ${plain(horizon.longTerm?.label ?? "לא זמין")}`, `משולב ${number(horizon.combined)}`] : []),
      ...(horizon?.factor ? [`פקטורים ${number(horizon.factor.score)} (דירוג ${number(horizon.factor.rank)})`] : []),
      ...(finite(horizon?.rs) ? [`RS ${horizon!.rs}`] : [])].join(" | "),
  ];
  if (horizon?.grades) lines.push(`ציונים: ${gradeChips(horizon.grades)}`);
  const c = horizon?.crowd;
  if (c && ((c.analysts ?? 0) > 0 || c.targetMean != null)) {
    const stars = starRating(result.price, c);
    lines.push([
      `אנליסטים ${number(c.analysts)}: קנייה ${c.buyPct != null ? pct(c.buyPct) : "לא זמין"}${c.buyPct3m != null ? ` (לפני 3 חודשים ${pct(c.buyPct3m)})` : ""}`,
      ...(c.targetMean != null ? [`יעד ממוצע ${number(c.targetMean)} (${signed(Number(((c.targetMean / result.price - 1) * 100).toFixed(1)))}%)`] : []),
      ...(c.targetLow != null && c.targetHigh != null ? [`טווח ${number(c.targetLow)}–${number(c.targetHigh)}`] : []),
      ...(stars ? [`${starText(stars.stars)} (אי-ודאות ${stars.uncertainty})`] : []),
    ].join(" | "));
    lines.push(`90 יום: העלאות דירוג ${c.upgrades90} / הורדות ${c.downgrades90} | העלאות יעד ${c.targetRaises90} / הורדות ${c.targetCuts90}`);
    if (c.insiderBuys != null || c.institutionsPct != null) {
      lines.push([
        ...(c.insiderBuys != null ? [`מקורבים 6 חודשים: קניות ${c.insiderBuys} / מכירות ${c.insiderSells ?? 0}`] : []),
        ...(c.institutionsPct != null ? [`מוסדיים ${number(Number((c.institutionsPct * 100).toFixed(1)))}%`] : []),
      ].join(" | "));
    }
  } else {
    lines.push("אין כיסוי אנליסטים במקור הנתונים.");
  }
  if (horizon?.topUp) lines.push(`חיזוק בתחילת השנה: ${plain(horizon.topUp.label)} — ${horizon.topUp.reasons.map(plain).join("; ")}`);
  lines.push(`רמות לבחינה (לא הוראת מכירה): סטופ סיכון ${number(result.risk?.stop)} | סטופ רצף ${number(result.sequenceStop)}${horizon?.longTerm ? ` | מחיר ${horizon.longTerm.aboveSma200 ? "מעל" : "מתחת ל"}ממוצע 200` : ""}`);
  if (finite(result.earningsInDays) && result.earningsInDays >= 0) lines.push(`דוחות כספיים בעוד ${result.earningsInDays} ימים`);
  return lines;
}

export function buildReportSummarySnapshot(input: ReportHtmlInput): ReportSummarySnapshot {
  const bySymbol = new Map(input.results.map((result) => [result.symbol, result]));
  const portfolio: HoldingSummary[] = PORTFOLIO.map((holding) => {
    const result = holding.symbol ? bySymbol.get(holding.symbol) : undefined;
    const price = result?.price ?? (holding.symbol ? input.extraPrices?.get(holding.symbol) : undefined) ?? input.extraPrices?.get(holding.name);
    const previous = holding.symbol ? input.prevScores?.get(holding.symbol) : undefined;
    const reference = !result && holding.triggerIndex ? input.indices.find((entry) => entry.symbol === holding.triggerIndex) : undefined;
    const fund = !result ? input.fundViews?.find((view) => view.name === holding.name) : undefined;
    const quoted = positive(price) ? describeQuoteStamp(input.quoteStamps?.get(holding.name), input.generatedAt) : null;
    return {
      name: plain(holding.name), symbol: holding.symbol, taseNumber: holding.taseNumber,
      ...(positive(holding.entryPrice) ? { entryPrice: holding.entryPrice } : {}),
      ...(holding.core ? { core: true } : {}),
      ...(positive(price) ? { price, ...(positive(holding.entryPrice) ? { returnPct: (price / holding.entryPrice - 1) * 100 } : {}) } : {}),
      ...(quoted ? { quotedAt: quoted.label } : {}),
      ...(result && finite(result.score) ? { score: result.score, ...(finite(previous) ? { scoreDelta: result.score - previous } : {}) } : {}),
      ...(positive(result?.sequenceStop) ? { sequenceStop: result.sequenceStop } : {}),
      ...(positive(result?.risk?.stop) ? { stop: result.risk.stop } : {}),
      coverage: result ? "analyzed" : positive(price) ? "price-only" : "missing",
      ...(reference ? { referenceIndex: { symbol: reference.symbol, name: plain(reference.name), stance: plain(reference.stance), trendUp: reference.indicators.trendUp, ...(finite(reference.score) ? { score: reference.score } : {}), ...(finite(reference.changePct) ? { changePct: reference.changePct } : {}) } } : {}),
      ...(fund ? { indexView: { index: plain(fund.indexName), action: fund.action, recommendation: fund.analysis.recommendation, combined: fund.horizon.combined, ...(fund.fund && fund.action !== "צמצום / מכירה" ? { fundStop: fund.fund.stop } : {}) } } : {}),
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
    const parts = [`${holding.name} (${[holding.symbol, holding.taseNumber].filter(Boolean).join(" / ")})${holding.core ? " · החזקת ליבה" : ""}`,
      positive(holding.entryPrice) ? `כניסה ${number(holding.entryPrice)}` : "כניסה: אין מחיר עלות", `מחיר ${number(holding.price)}${holding.quotedAt ? ` (${holding.quotedAt})` : ""}`,
      `יחידות: ${holding.symbol && !holding.symbol.endsWith(".TA") ? "דולר" : "אגורות"}`,
      `רווח/הפסד ${finite(holding.returnPct) ? `${signed(Number(holding.returnPct.toFixed(1)))}%` : "לא זמין"}`];
    if (finite(holding.score)) parts.push(`ציון ${number(holding.score)}${finite(holding.scoreDelta) ? ` | Δ ${signed(holding.scoreDelta)}` : " | Δ לא זמין"}`);
    if (holding.coverage === "analyzed") {
      parts.push(`סטופ רצף ${number(holding.sequenceStop)}`, `סטופ סיכון ${number(holding.stop)}`);
      const horizon = holding.symbol ? input.horizons?.get(holding.symbol) : undefined;
      if (horizon) parts.push(`שבועי ${number(horizon.weeklyScore)}`, `ארוך ${plain(horizon.longTerm?.label ?? "לא זמין")}`, `משולב ${number(horizon.combined)}`);
      if (horizon?.factor) parts.push(`פקטורים ${number(horizon.factor.score)} (דירוג ${number(horizon.factor.rank)})`);
      if (horizon?.grades) parts.push(`ציונים: ${gradeChips(horizon.grades)}`);
      if (horizon?.grades?.redFlags.length) parts.push(`דגלים: ${horizon.grades.redFlags.map(plain).join("; ")}`);
    } else {
      parts.push(`${holding.coverage === "price-only" ? "מחיר בלבד" : "מחיר חסר"}; ${holding.indexView ? `ניתוח לפי המדד ${holding.indexView.index}: ${holding.indexView.action} | המלצה למדד ${plain(holding.indexView.recommendation)} | משולב ${number(holding.indexView.combined)}${finite(holding.indexView.fundStop) ? ` | סטופ לקרן ≈ ${number(holding.indexView.fundStop)}` : ""}` : `ללא ניתוח טכני, אין ציון או סטופ${holding.quotedAt ? "" : "; זמן הציטוט לא ידוע"}`}`);
      const underlying = input.macro?.underlying?.find((u) => u.taseNumber === definition.taseNumber);
      if (underlying) parts.push(plain(underlyingText(underlying)));
    }
    if (definition.triggerIndex) {
      const trigger = input.leverageTriggers?.get(definition.triggerIndex);
      const benchmark = input.indices.find((entry) => entry.symbol === definition.triggerIndex);
      if (trigger) {
        parts.push(`מדד ייחוס ${plain(definition.triggerIndex)} | ממוצע 200: ${trigger.aboveSma200 ? "מעל" : "מתחת"} (${signed(Number(trigger.distancePct.toFixed(1)))}%) | ירידה מהשיא ${number(Number(trigger.drawdownPct.toFixed(1)))}%${trigger.sma50BelowSma200 ? " | ממוצע 50 מתחת ל-200" : ""}; אינו ניתוח של הקרן`);
      } else {
        parts.push(`מדד ייחוס ${plain(definition.triggerIndex)}: ${benchmark ? `${plain(benchmark.stance)}; מגמת ממוצעים ${benchmark.indicators.trendUp ? "חיובית" : "לא חיובית"}; ציון ${number(benchmark.score)}${finite(benchmark.changePct) ? `; שינוי ${signed(benchmark.changePct)}%` : ""}` : "אין נתונים"}; אינו ניתוח של הקרן`);
      }
    }
    lines.push(parts.join(" | "));
  }
  lines.push("", "===== התראות סיכון שמרניות =====", "כל דגל מוצג לבדיקה; אלו אינן דרגות החומרה של מקטע המכירה בדוח.");
  const alerts = portfolio.filter((holding) => holding.alerts.length);
  if (!alerts.length) lines.push("לא זוהו דגלי סיכון בנתונים הזמינים; אין בכך אישור שכל ההחזקות מעל סטופ או מכוסות בניתוח.");
  for (const holding of alerts) lines.push(`${holding.name} (${holding.symbol ?? holding.taseNumber})${holding.core ? " · החזקת ליבה, לבחינה בלבד" : ""}: ${holding.alerts.join(" | ")}`);
  if (portfolio.some((holding) => holding.coverage !== "analyzed")) lines.push("הכיסוי הטכני של התיק חלקי; החזקות ללא ניתוח אינן נבדקות ליציאה טכנית.");
  const core = PORTFOLIO.filter((holding) => holding.core && holding.symbol);
  if (core.length) {
    lines.push("", "===== ניתוח החזקות ליבה =====", "החזקות קבועות: אין המלצת מכירה; הרמות לבחינה בלבד. כוכבים בסגנון Morningstar (קירוב לפי יעד האנליסטים).");
    for (const holding of core) {
      lines.push(`${plain(holding.name)} (${plain(holding.symbol!)}) · החזקת ליבה`);
      for (const line of coreHoldingLines(holding, bySymbol.get(holding.symbol!), input.horizons?.get(holding.symbol!))) lines.push(`  ${plain(line)}`);
    }
  }
  const pick = selectDailyPick(input.results, input.horizons, input.regime);
  lines.push("", "===== המלצת הרכישה =====", pick.main ? pickLine(pick.main, input) : "אין מועמדת שעברה את מסנני הבחירה עם הנתונים הזמינים.");
  for (const alternative of pick.alts) lines.push(`חלופה: ${pickLine(alternative, input)}`);
  if (pick.strengthen && !holdingSellAlerts(input.results, input.horizons, input.newsByStock).some(alert => alert.symbol === pick.strengthen?.r.symbol)) {
    lines.push(`חיזוק החזקה: ${pickLine(pick.strengthen, input)}`);
  }
  if (pick.regimeNote) lines.push(plain(pick.regimeNote));
  if (input.regime) lines.push(`מצב שוק: ${plain(input.regime.label)} | ציון ${number(input.regime.score)} | רוחב ${number(input.regime.breadthPct)}%`);
  if (input.macro) {
    lines.push(input.macro.flags.length
      ? `דגלי מאקרו: ${input.macro.flags.map((f) => `${plain(f.label)} (${plain(f.detail)})`).join(" | ")}`
      : "אין דגלי מאקרו פעילים.");
    lines.push(`כותרות גאופוליטיות: ${plain(input.macro.geo.level)} (${input.macro.geo.count} מתוך ${input.macro.geo.total}${input.macro.geo.percentile != null ? `, אחוזון ${input.macro.geo.percentile} מול 60 יום` : ""})`);
    for (const example of input.macro.geo.examples) lines.push(`  • ${plain(example.title)} (${plain(example.source)})`);
  }
  lines.push(`מנוע: ${plain(describeEngine(input.engine))}`);
  lines.push(plain(describeGradeValidation(input.gradeValidation, GRADES_IN_RANKING)));
  if (input.fundViews?.length) {
    lines.push("", "===== הקרנות שלי — ניתוח לפי המדד =====", "המנוע המלא על נרות המדד; הסטופ והיעד לקרן = המרחק במדד × המינוף (קירוב).");
    for (const v of input.fundViews) {
      const a = v.analysis;
      const sma200Pct = v.sma200 ? (a.price / v.sma200 - 1) * 100 : null;
      lines.push(`${plain(v.name)} (${plain(v.id)})${v.leverage !== 1 ? ` ×${v.leverage}` : ""} | לפי ${plain(v.indexName)} (${plain(v.historySymbol)}) | ${v.action}`
        + ` | מדד ${number(a.price)} | יומי ${number(a.score)} | שבועי ${number(v.horizon.weeklyScore)} | ארוך ${plain(v.horizon.longTerm?.label ?? "לא זמין")} | משולב ${number(v.horizon.combined)} | ${plain(a.recommendation)}`
        + ` | ממוצע 150 ${finite(v.method?.sma150Pct) ? `${signed(Number(v.method!.sma150Pct!.toFixed(1)))}%` : "לא זמין"} | ממוצע 200 ${finite(sma200Pct) ? `${signed(Number(sma200Pct.toFixed(1)))}%` : "לא זמין"}`
        + (a.risk ? ` | במדד: סטופ ${number(a.risk.stop)} יעד ${number(a.risk.target)}` : "")
        + (v.fund ? ` | לקרן ≈ סטופ ${number(v.fund.stop)} (-${number(Number(v.fund.riskPct.toFixed(1)))}%) יעד ${number(v.fund.target)}` : ""));
      lines.push(`  למה: ${v.reasons.map(plain).join("; ")}`);
      if (v.historyNote) lines.push(`  ${plain(v.historyNote)}`);
    }
  }
  if (input.horizons?.size) {
    lines.push("", "===== המלצות לפי בורסה =====", "כל בורסה לפי מצב השוק שלה; אותם מסננים כמו המלצת היום. קרן מופיעה בבורסה של המדד שלה.");
    for (const m of marketRecommendations(input)) {
      lines.push(`--- ${plain(m.label)}${m.regime ? ` | מצב שוק ${plain(m.regime.label)} (${number(m.regime.score)}, רוחב ${number(Number(m.regime.breadthPct.toFixed(0)))}%) לפי ${plain(m.regime.benchmarkName)}` : ""} | ${m.analyzed} ניירות נותחו ---`);
      const buys = [
        ...(m.pick.main ? [`ראשונה: ${pickLine(m.pick.main, input)}`] : []),
        ...m.pick.alts.map((x) => `חלופה: ${pickLine(x, input)}`),
        ...(m.strengthen ? [`חיזוק החזקה: ${pickLine(m.strengthen, input)}`] : []),
        ...m.fundBuys.map((f) => `חיזוק קרן: ${plain(f.name)} | לפי ${plain(f.indexName)} | ${plain(f.reasons[0] ?? "")}${f.fund ? ` | סטופ לקרן ≈ ${number(f.fund.stop)}` : ""}`),
      ];
      lines.push("קנייה:", ...(buys.length ? buys.map((b) => `  ${b}`) : ["  אין מועמדת שעוברת את המסננים — עדיף להמתין."]));
      lines.push("מכירה / צמצום בתיק:", ...(m.sells.length
        ? m.sells.map((s) => `  ${plain(s.action)}: ${plain(s.name)} (${plain(s.id)})${finite(s.price) ? ` | מחיר ${number(s.price)}` : ""}${finite(s.level) ? ` | רמת יציאה ${number(s.level)}` : ""} | ${s.reasons.map(plain).join("; ")}`)
        : ["  אין החזקה עם התראת יציאה לפי סף המנוע."]));
      if (m.avoid.length) lines.push("להימנע מקנייה (איתות מכירה טרי):", ...m.avoid.map((a) => `  ${plain(a.name)} (${plain(a.symbol)}) | ציון ${number(a.score)} | ${plain(a.reason)}`));
    }
  }
  if (input.exposure?.length) {
    lines.push("", "===== רגישות התיק לתרחישים =====", "תנועה משוערת לפי בטא 60 יום, כל גורם בנפרד; לא תחזית.");
    const move = (v: number | null) => (finite(v) ? `${signed(Number(v.toFixed(1)))}%` : "לא זמין");
    for (const row of input.exposure) {
      lines.push(`${plain(row.name)}${row.leverage !== 1 ? ` (×${row.leverage})` : ""} | ברנט +10%: ${move(row.brentUp10)} | נאסד"ק −5%: ${move(row.ndxDown5)} | ת"א 35 −5%: ${move(row.ta35Down5)} | דולר +3%: ${move(row.usdUp3)}`);
    }
  }
  if (input.creator) {
    const c = input.creator;
    lines.push("", `===== ${c.channels.map(plain).join(", ")} — עדכונים ושיטה =====`, "תוכן מתוך תיאורי הסרטונים ביוטיוב; זיהוי המבנים אוטומטי לפי השיטה שהוא מלמד ואינו המלצה שלו.");
    lines.push("הכללים שמופעלים על ההמלצות:");
    for (const r of METHOD_RULES) lines.push(`  ${plain(r.rule)} (${plain(r.source)}) → ${plain(r.effect)}`);
    const blocked = pick.rejected.filter((x) => x.reason.startsWith(METHOD_REJECT_PREFIX));
    lines.push(blocked.length ? "מועמדות קנייה מובילות שנפסלו לפי הכללים:" : "אף מועמדת קנייה מובילה לא נפסלה לפי הכללים.");
    for (const x of blocked) lines.push(`  ${plain(x.name)} (${plain(x.symbol)}) — ${plain(x.reason.slice(METHOD_REJECT_PREFIX.length))}`);
    lines.push("ההחזקות שלי לפי הכללים:");
    if (!c.holdings.length) lines.push("  אין נתוני מחיר להחזקות בהרצה זו.");
    for (const h of c.holdings) {
      lines.push(`  ${plain(h.name)} (${plain(h.id)})${h.basis === "index" ? ` · לפי מדד ${plain(h.basisName ?? "")}` : ""} | ${h.basis === "index" ? "ערך המדד" : "מחיר"} ${number(h.price)} | ממוצע 150 ${number(h.check.sma150 == null ? null : Number(h.check.sma150.toFixed(2)))} | ${plain(h.verdict)}`);
    }
    if (c.holdingsWithoutData.length) lines.push(`  ללא היסטוריית מחירים: ${c.holdingsWithoutData.map(plain).join(", ")}`);
    if (c.concentration) lines.push(`  ריכוזיות: ${plain(c.concentration)}`);
    lines.push("סרטונים מ-7 הימים האחרונים:");
    if (!c.videos.length) lines.push("  לא התקבלו סרטונים מהשבוע האחרון.");
    for (const v of c.videos.slice(0, 10)) {
      lines.push(`  ${v.isNew ? "🆕 " : ""}${plain(v.published.slice(0, 10))} | ${plain(v.title)}${v.blurb ? ` | ${plain(v.blurb).slice(0, 200)}` : ""}`);
    }
    const rowLine = (r: CreatorRow) => [`${plain(r.name)} (${plain(r.symbol)})${r.held ? " · בתיק" : ""}`, `מחיר ${number(r.price)}`,
      ...(r.setup.status === "none" ? [] : [SETUP_LABEL[r.setup.status], `טריגר ${number(r.setup.trigger)}`, `סטופ ${number(r.setup.stop)}`, `יעד ${number(r.setup.target)}`,
        `סיכוי/סיכון ${number(r.setup.rr)}`]), ...(finite(r.combined) ? [`משולב ${number(r.combined)}`] : []), plain(r.verdict)].join(" | ");
    lines.push("אזכורים:");
    if (!c.mentions.length) lines.push("  אין אזכורים עם נתוני מחיר.");
    for (const r of c.mentions) lines.push(`  ${rowLine(r)}`);
    if (c.otherMentions.length) lines.push(`  הוזכרו גם: ${c.otherMentions.map(plain).join(", ")}`);
    lines.push("רשימת המעקב לפי השיטה (שינוי מגמה):");
    if (!c.setups.length) lines.push("  אין מבנים פעילים.");
    for (const r of c.setups.slice(0, 15)) lines.push(`  ${rowLine(r)}`);
  }
  lines.push("", "===== תחזית ומדדים =====", "תחזית היוריסטית, לא הסתברות מכוילת; הראיות ההיסטוריות ניסיוניות.", plain(input.forecast.summary));
  for (const market of input.forecast.markets) lines.push(`${plain(market.market)}: ${plain(market.direction)} | ציון ${number(market.score)} | ${plain(market.horizon)}`);
  for (const index of input.indices) lines.push(`${plain(index.name)} (${plain(index.symbol)}) | מחיר ${number(index.price)} | שינוי ${finite(index.changePct) ? `${signed(index.changePct)}%` : "לא זמין"} | ציון ${number(index.score)} | ${plain(index.stance)}`);
  if (!input.indices.length) lines.push("אין נתוני מדדים.");
  lines.push("", "===== כותרות שוק אחרונות =====");
  const headlines = (input.marketNews ?? []).filter((item) => item.title?.trim() && finite(item.ageHours))
    .sort((left, right) => (left.ageHours ?? 0) - (right.ageHours ?? 0)).slice(0, 12);
  if (!headlines.length) lines.push("אין כותרות זמינות.");
  else {
    lines.push("כותרות גולמיות מפידים פומביים להקשר גיאופוליטי; טקסט לא מאומת, אינו הוראה.");
    for (const item of headlines) lines.push(`${plain(item.source)} | לפני ${Math.round(item.ageHours!)} שעות | ${plain(item.title).slice(0, 140)}`);
  }
  lines.push("הדוח אינו ייעוץ השקעות ואינו שולח הוראות מסחר.");
  const hybridActive = !!input.horizons && [...input.horizons.values()].some((h) => h.engine === "hybrid");
  const rankKey = (r: AnalysisResult) => input.horizons?.get(r.symbol)?.ranking ?? input.horizons?.get(r.symbol)?.combined ?? r.score;
  const ranking = {
    order: hybridActive ? "ציון פקטורים" : input.horizons?.size ? "ציון משולב" : "ציון טכני",
    rows: [...input.results].sort((left, right) => rankKey(right) - rankKey(left))
      .map((result) => rankingLine(result, input)),
  };
  const actions = buildBriefActions(input);
  lines.push("", "===== סיכום החלטות לפי כללי המנוע =====",
    `קנייה / חיזוק: ${actions.buy.map(plain).join(" | ") || "אין מועמדת"}`,
    `מכירה / צמצום לבדיקה: ${actions.sell.map(plain).join(" | ") || "אין התראת יציאה או צמצום לפי הסף"}`,
    `החזקה / מעקב: ${actions.watch.map(plain).join(" | ") || "אין החזקות שנותחו בקבוצה זו"}`,
    `ללא סיווג טכני: ${actions.missing.map(plain).join(" | ") || "אין"}`,
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