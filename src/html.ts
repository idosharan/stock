/**
 * הפקת דוחות HTML מעוצבים ובניית עמוד index.html עם סרגל צד וניווט יומי/שבועי.
 */
import type { AnalysisResult, HorizonInfo, LongTermView } from "./analysis.js";
import type { IndexAnalysis, MarketStance } from "./indices.js";
import { METHOD_RULES, methodPassLine, type StockNews, type NewsItem, type CreatorView, type CreatorRow } from "./news.js";
import type { Mode, PickScorecard, PriceCheckEntry, SignalDelta } from "./report.js";
import type { ForecastResult, ForecastDirection, HistoricalForecast } from "./forecast.js";
import type { MarketRegime } from "./regime.js";
import type { CorrPair } from "./risk.js";
import type { BetaEntry } from "./runner.js";
import { selectDailyPick } from "./pick.js";
import { PORTFOLIO, STOCK_SECTORS, HELD_SECTORS, PARAMS, RISK, GRADES_IN_RANKING, type HoldingDef } from "./config.js";
import { buildReportSummarySnapshot, coreHoldingLines, describeQuoteStamp, starText, type DataHealth, type QuoteStamp, type ReportSummarySnapshot } from "./summary.js";
import { renderPortfolioBrief, BRIEF_CSS } from "./brief.js";
import { describeEngine, underlyingText, type EngineValidation, type SensitivityRow, type LeverageTrigger, type MacroView, type UnderlyingStatus } from "./engine.js";
import { describeGradeValidation, gradeChips, gradeWhy, starRating, GRADE_KEYS, type EvidenceGrades, type GradeValidation } from "./grades.js";
import { SETUP_LABEL } from "./indicators.js";
import { FUND_BUY_MIN_COMBINED, type FundAction, type FundIndexView } from "./engine.js";
import { marketRecommendations } from "./brief.js";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** מאשר רק קישורי http/https — מונע javascript: מפידי RSS חיצוניים. */
function safeLink(link: string | undefined | null): boolean {
  return !!link && /^https?:\/\//i.test(link);
}

function recClass(rec: string): string {
  switch (rec) {
    case "קנייה חזקה":
      return "rec-strong-buy";
    case "קנייה":
      return "rec-buy";
    case "החזקה":
      return "rec-hold";
    default:
      return "rec-sell";
  }
}

function stanceClass(stance: MarketStance): string {
  switch (stance) {
    case "חיובי חזק":
      return "rec-strong-buy";
    case "חיובי":
      return "rec-buy";
    case "ניטרלי":
      return "rec-hold";
    default:
      return "rec-sell";
  }
}

export interface ReportHtmlInput {
  mode: Mode;
  results: AnalysisResult[];
  indices: IndexAnalysis[];
  newsByStock: Map<string, StockNews>;
  /** כותרות שוק כלליות לתקציר ה-AI — טקסט לא מהימן מפידים חיצוניים. */
  marketNews?: NewsItem[];
  forecast: ForecastResult;
  generatedAt: Date;
  /** ציוני הדוח הקודם (symbol -> score) להצגת Δ. */
  prevScores?: Map<string, number> | null;
  /** מחיר אחרון לניירות ללא ניתוח מלא — למקטע התיק. */
  extraPrices?: Map<string, number>;
  /** אופקים נוספים (שבועי + ארוך טווח) לדוח המשולב. */
  horizons?: Map<string, HorizonInfo>;
  regime?: MarketRegime | null;
  correlations?: CorrPair[];
  betas?: BetaEntry[];
  priceChecks?: PriceCheckEntry[];
  sparkCloses?: Map<string, number[]>;
  /** זמן הציטוט לכל החזקה, לפי שם ההחזקה. */
  quoteStamps?: Map<string, QuoteStamp>;
  scorecard?: PickScorecard;
  signalDeltas?: Map<string, SignalDelta>;
  historicalForecasts?: Map<string, HistoricalForecast>;
  dataHealth?: DataHealth;
  summary?: ReportSummarySnapshot;
  /** SMA200 status of each leveraged/index holding's reference index. */
  leverageTriggers?: Map<string, LeverageTrigger>;
  macro?: MacroView;
  exposure?: SensitivityRow[];
  engine?: EngineValidation | null;
  gradeValidation?: GradeValidation | null;
  /** Followed creator videos, mentions and trend-change setups. */
  creator?: CreatorView;
  /** Funds analysed through their reference index (full engine on the index, levels translated to the fund). */
  fundViews?: FundIndexView[];
  /** US market regime (S&P 500 + US breadth); `regime` is the Tel Aviv one. */
  usRegime?: MarketRegime | null;
}

const fmt = (n: number, digits = 2): string =>
  n.toLocaleString("he-IL", { maximumFractionDigits: digits });

/** Return vs cost basis in percent; null when the holding has no entry price (core holdings may omit it). */
const plPctOf = (price: number | null | undefined, entry: number | undefined): number | null =>
  price != null && entry != null && entry > 0 ? ((price - entry) / entry) * 100 : null;

/** כרטיס ציוני הראיות: אותיות A–F, שורת "למה" ודגלים אדומים. */
function gradeHtml(g: EvidenceGrades | undefined): string {
  if (!g) return "";
  const why = gradeWhy({ ...g, redFlags: [] });
  return `<div class="grades">${esc(gradeChips(g))}</div>${why ? `<div class="grades-why">${esc(why)}</div>` : ""}${
    g.redFlags.map((f) => `<div class="grades-flag">🚩 ${esc(f)}</div>`).join("")}`;
}

const gradeLetters = (g: EvidenceGrades | undefined): string => (g ? GRADE_KEYS.map((k) => g.letters[k] ?? "—").join("") : "—");

function renderHistoricalEvidence(evidence: HistoricalForecast | undefined): string {
  if (!evidence) return '<p class="note">אין נתוני תחזית היסטורית; לא מוצגת הסתברות.</p>';
  const percent = (value: number | null, probability = false): string =>
    value == null || !Number.isFinite(value) || (probability && (value < 0 || value > 1))
      ? "לא זמין"
      : `<bdi>${(value * (probability ? 100 : 1)).toFixed(probability ? 1 : 2)}%</bdi>`;
  const regimes = { trend: "מגמה", range: "דשדוש", stress: "לחץ", unknown: "לא ידוע" };
  const rows = [5, 10, 20].map((days) => {
    const horizon = evidence.horizons.find((entry) => entry.days === days);
    const sample = horizon?.sampleCount ?? 0;
    if (!horizon || horizon.status !== "estimated") {
      return `<tr><th scope="row">${days} ימי מסחר</th><td class="num">${sample}</td>
        <td colspan="7" class="abstention">אין מספיק נתונים; אין אומדן${horizon?.reason ? `: ${esc(horizon.reason)}` : ""}</td></tr>`;
    }
    const interval = horizon.probabilityInterval;
    return `<tr><th scope="row">${days} ימי מסחר</th><td class="num">${sample}</td>
      <td class="num">${percent(horizon.medianReturn)}</td>
      <td class="num">${percent(horizon.probabilityUp, true)}</td>
      <td class="num">${interval ? `<span dir="ltr">${percent(interval[0], true)} / ${percent(interval[1], true)}</span>` : "לא זמין"}</td>
      <td class="num"><span dir="ltr">${percent(horizon.p10)} / ${percent(horizon.p90)}</span></td>
      <td class="num">${percent(horizon.baselineProbability, true)}</td>
      <td class="num">${percent(horizon.baselineReturn)}</td><td class="num">${percent(horizon.excessReturn)}</td></tr>`;
  }).join("");
  const analogs = evidence.horizons.filter((horizon) => horizon.analogDates.length).map((horizon) =>
    `<li>${esc(String(horizon.days))} ימים: ${horizon.analogDates.map((date) => `<bdi>${esc(date)}</bdi>`).join(", ")}</li>`).join("");
  const events = evidence.events.length
    ? `<ul>${evidence.events.map((event) => `<li>${esc(event.type)}: מדגם ${event.sampleCount}; חציון ${percent(event.medianReturn)}; שכיחות עלייה ${percent(event.probabilityUp, true)}</li>`).join("")}</ul>`
    : '<p class="note">אין מאגר אירועים מתוארך; לא מוצג אומדן השפעת אירוע.</p>';
  return `<div class="historical-evidence">
    <p class="evidence-meta"><bdi>${esc(evidence.symbol)}</bdi> · נכון ל־${esc(evidence.asOf ?? "תאריך לא זמין")} · משטר: ${esc(regimes[evidence.regime])}</p>
    <p class="note">ניסיוני: שכיחות היסטורית במקרים דומים, לא הסתברות מכוילת או הבטחת תשואה. תשואות נטו לפי הנחות העלות במודל; חלופות ייחוס מאותם אופקים.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="ראיות היסטוריות ${esc(evidence.symbol)}">
      <table class="evidence-table"><caption>אופקי תחזית היסטורית נטו</caption><thead><tr>
        <th scope="col">אופק</th><th scope="col">מדגם</th><th scope="col">חציון נטו</th><th scope="col">שכיחות עלייה</th>
        <th scope="col">רווח סמך 95%</th><th scope="col">P10 / P90</th><th scope="col">שכיחות ייחוס</th><th scope="col">תשואת ייחוס</th><th scope="col">תשואה עודפת</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>
    ${analogs ? `<details class="evidence-dates"><summary>תאריכי המקרים הדומים</summary><ul>${analogs}</ul></details>` : ""}
    <h5>ראיות מאירועים</h5>${events}
    ${evidence.warnings.length ? `<ul class="evidence-warnings">${evidence.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

function renderPortfolioEvidence(forecasts?: Map<string, HistoricalForecast>): string {
  return `<section id="evidence" class="portfolio-evidence"><h2>ראיות היסטוריות לתיק</h2>${PORTFOLIO.map((holding) => {
    const symbol = holding.symbol ?? holding.triggerIndex;
    return `<details class="evidence-holding"><summary>${esc(holding.name)}${!holding.symbol && holding.triggerIndex ? " · מדד ייחוס בלבד, לא תחזית לקרן הממונפת" : ""}</summary>
      ${renderHistoricalEvidence(symbol ? forecasts?.get(symbol) : undefined)}</details>`;
  }).join("")}</section>`;
}

/** גרף מיני (sparkline) מסדרת סגירות, עם קו סטופ אופציונלי. */
function sparkline(closes: number[] | undefined, stop?: number | null): string {
  if (!closes || closes.length < 5) return "";
  const w = 120;
  const h = 32;
  const values = stop != null ? [...closes, stop] : closes;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (closes.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * h;
  const points = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stopLine =
    stop != null
      ? `<line x1="0" y1="${y(stop).toFixed(1)}" x2="${w}" y2="${y(stop).toFixed(1)}" class="spark-stop" vector-effect="non-scaling-stroke" />`
      : "";
  return `<svg class="spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="מגמת מחיר">${stopLine}<polyline points="${points}" vector-effect="non-scaling-stroke" /></svg>`;
}

/** תגית זמן ציטוט: ירוקה לציטוט תוך-יומי מהיום, אפורה למחיר קודם. */
function quoteChip(stamp: QuoteStamp | undefined, generatedAt: Date): string {
  const quote = describeQuoteStamp(stamp, generatedAt);
  if (!quote) return `<span class="quote-chip unknown">זמן ציטוט לא ידוע</span>`;
  return `<span class="quote-chip ${quote.today ? "live" : "stale"}" title="זמן העסקה האחרונה לפי המקור"><bdi>${esc(quote.when)}</bdi> · <bdi>${esc(quote.source)}</bdi></span>`;
}

/** לוח פעולות: פעולה אחת לכל החזקה, מרחק מהסטופ, זמן ציטוט וגרף 30 יום. */
function renderActionBoard(input: ReportHtmlInput): string {
  if (!PORTFOLIO.length) return "";
  const bySymbol = new Map(input.results.map((r) => [r.symbol, r]));
  const idxBySymbol = new Map(input.indices.map((i) => [i.symbol, i]));
  const fundByName = new Map((input.fundViews ?? []).map((v) => [v.name, v]));
  const cards = PORTFOLIO.map((h) => {
    const r = h.symbol ? bySymbol.get(h.symbol) : undefined;
    const fv = r ? undefined : fundByName.get(h.name);
    const price = r?.price ?? (h.symbol ? input.extraPrices?.get(h.symbol) : undefined) ?? input.extraPrices?.get(h.name) ?? null;
    const pl = plPctOf(price, h.entryPrice);
    let action: { label: string; cls: string };
    let reason = "";
    let stopHtml = "";
    let rank: number;
    if (r) {
      const { severity, reasons } = holdingSeverity(h, r, input.horizons?.get(r.symbol), input.newsByStock);
      action = holdingAction(severity, h.core === true);
      rank = severity;
      reason = reasons[0] ?? `ציון ${r.score} · ${r.recommendation}`;
      const stop = r.sequenceStop ?? r.risk?.stop ?? null;
      if (stop != null) {
        const dist = ((r.price - stop) / r.price) * 100;
        stopHtml = `<div class="act-stop ${dist < 1.5 ? "near" : ""}"><span>סטופ</span><bdi>${fmt(stop)}</bdi><span class="act-dist"><bdi>${Math.abs(dist).toFixed(1)}%</bdi> ${dist >= 0 ? "מתחת למחיר" : "מעל המחיר (נשבר)"}</span></div>`;
      }
    } else if (fv) {
      const reduce = fv.action === "צמצום / מכירה";
      action = reduce ? { label: "לצמצם", cls: "act-reduce" } : fv.action === "קנייה / חיזוק" ? { label: "לחזק", cls: "act-hold" } : { label: "להחזיק", cls: "act-hold" };
      rank = reduce ? 4 : 0;
      reason = `לפי ${fv.indexName}: ${fv.reasons[0] ?? fv.analysis.recommendation}`;
      if (fv.fund && !reduce) {
        stopHtml = `<div class="act-stop"><span>סטופ ≈</span><bdi>${fmt(fv.fund.stop)}</bdi><span class="act-dist"><bdi>${fv.fund.riskPct.toFixed(1)}%</bdi> מתחת למחיר (לפי המדד)</span></div>`;
      }
    } else if (h.triggerIndex && input.leverageTriggers?.get(h.triggerIndex)) {
      const st = leverageStatus(input.leverageTriggers.get(h.triggerIndex)!, idxBySymbol.get(h.triggerIndex)?.name ?? h.triggerIndex);
      action = { label: st.label, cls: st.cls };
      rank = st.rank;
      reason = st.text;
    } else if (h.triggerIndex && idxBySymbol.get(h.triggerIndex)) {
      const idx = idxBySymbol.get(h.triggerIndex)!;
      action = idx.indicators.trendUp ? { label: "להחזיק", cls: "act-hold" } : { label: "טריגר אזהרה", cls: "act-tight" };
      rank = idx.indicators.trendUp ? 0 : 3;
      reason = `לפי מדד ${idx.name}: ${idx.stance}, ממוצע ${PARAMS.smaShort} ${idx.indicators.trendUp ? "מעל" : "מתחת ל"} ${PARAMS.smaLong}`;
    } else if (input.macro?.underlying?.some((u) => u.taseNumber === h.taseNumber)) {
      const u = input.macro.underlying.find((x) => x.taseNumber === h.taseNumber)!;
      action = u.hit ? { label: "לצמצם", cls: "act-reduce" } : { label: "להחזיק", cls: "act-hold" };
      rank = u.hit ? 4 : 0;
      reason = underlyingText(u);
    } else {
      action = { label: "מחיר בלבד", cls: "act-none" };
      rank = -1;
      reason = price != null ? "אין ניתוח טכני לנייר זה" : "מחיר לא התקבל בהרצה זו";
    }
    const spark = h.symbol ? sparkline(input.sparkCloses?.get(h.symbol)?.slice(-30), r?.sequenceStop ?? r?.risk?.stop ?? null)
      : fv ? sparkline(input.sparkCloses?.get(fv.indexSymbol)?.slice(-30)) : "";
    const html = `<article class="act-card ${action.cls}">
      <header><h3>${esc(h.name)}</h3><span class="act-pill">${esc(action.label)}</span></header>
      <div class="act-price"><strong><bdi>${price != null ? fmt(price) : "—"}</bdi></strong>${pl != null ? `<span class="pl ${pl >= 0 ? "up" : "down"}"><bdi>${pl >= 0 ? "+" : ""}${pl.toFixed(1)}%</bdi></span>` : ""}</div>
      ${quoteChip(price != null ? input.quoteStamps?.get(h.name) : undefined, input.generatedAt)}
      ${stopHtml}
      ${spark}
      <p class="act-reason">${esc(reason)}</p>
    </article>`;
    return { rank, html };
  });
  cards.sort((a, b) => b.rank - a.rank);
  return `<div class="act-board" aria-label="פעולה לכל החזקה">${cards.map((c) => c.html).join("")}</div>
    <p class="note">הפעולה נגזרת מאותו סולם חומרה של מקטע המכירה. מרחק הסטופ מחושב מול סטופ הרצף, ואם אין — מול סטופ הסיכון. אין זו הוראת מסחר.</p>`;
}

const MARKET_STRIP = ["TA35.TA", "TA90.TA", "^GSPC", "^NDX", "^VIX"];

/** פס מדדים מרכזיים עם שינוי יומי וגרף 30 יום. */
function renderMarketStrip(indices: IndexAnalysis[], sparkCloses?: Map<string, number[]>): string {
  const chips = MARKET_STRIP.map((symbol) => indices.find((i) => i.symbol === symbol)).filter((i): i is IndexAnalysis => !!i)
    .map((idx) => {
      const chg = idx.changePct;
      // VIX rising is risk-off, so its colour is inverted.
      const good = chg == null ? null : idx.symbol === "^VIX" ? chg <= 0 : chg >= 0;
      return `<div class="mkt-chip ${good == null ? "" : good ? "good" : "bad"}">
        <span class="mkt-name">${esc(idx.name)}</span>
        <strong><bdi>${fmt(idx.price)}</bdi></strong>
        ${chg != null ? `<span class="mkt-chg"><bdi>${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</bdi></span>` : ""}
        ${sparkline(sparkCloses?.get(idx.symbol))}
      </div>`;
    });
  return chips.length ? `<div class="mkt-strip" aria-label="מדדים מרכזיים">${chips.join("")}</div>` : "";
}

function ltBadge(lt: LongTermView | null): string {
  if (!lt) return `<span class="lt na">—</span>`;
  const cls = lt.label === "חיובי" ? "pos" : lt.label === "שלילי" ? "neg" : "neu";
  const icon = lt.label === "חיובי" ? "⬆️" : lt.label === "שלילי" ? "⬇️" : "➡️";
  return `<span class="lt ${cls}">${icon} ${lt.label}</span>`;
}

/** תג Δ שינוי ציון מול הדוח הקודם; מחרוזת ריקה אם אין נתון קודם. */
function deltaHtml(symbol: string, score: number, prevScores?: Map<string, number> | null): string {
  const prev = prevScores?.get(symbol);
  if (prev == null) return "";
  const d = score - prev;
  if (d === 0) return `<span class="delta flat">±0</span>`;
  return d > 0
    ? `<span class="delta up">▲+${d}</span>`
    : `<span class="delta down">▼${d}</span>`;
}

/** מקטע "התיק שלי" — החזקות, רווח/הפסד וטריגרים לקרנות ממונפות. */
function renderPortfolioSection(
  results: AnalysisResult[],
  indices: IndexAnalysis[],
  prevScores?: Map<string, number> | null,
  extraPrices?: Map<string, number>,
  horizons?: Map<string, HorizonInfo>,
  sparkCloses?: Map<string, number[]>,
  signalDeltas?: Map<string, SignalDelta>,
  priceChecks?: PriceCheckEntry[],
  quoteStamps?: Map<string, QuoteStamp>,
  generatedAt: Date = new Date(),
  leverageTriggers?: Map<string, LeverageTrigger>,
  underlying?: UnderlyingStatus[],
  fundViews?: FundIndexView[]
): string {
  if (!PORTFOLIO.length) return "";
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));
  const idxBySymbol = new Map(indices.map((i) => [i.symbol, i]));
  const checkBySymbol = new Map((priceChecks ?? []).map((c) => [c.symbol, c]));
  const fundByName = new Map((fundViews ?? []).map((v) => [v.name, v]));

  const rows = PORTFOLIO.map((h) => {
    const r = h.symbol ? bySymbol.get(h.symbol) : undefined;
    // ניירות ללא ניתוח מלא: מחיר לפי סימול (Yahoo) או לפי שם ההחזקה (investing.com)
    const price = r?.price ?? (h.symbol ? extraPrices?.get(h.symbol) : undefined) ?? extraPrices?.get(h.name) ?? null;
    const plPct = plPctOf(price, h.entryPrice);
    const plHtml =
      plPct != null
        ? `<span class="pl ${plPct >= 0 ? "up" : "down"}">${plPct >= 0 ? "▲" : "▼"} ${Math.abs(plPct).toFixed(1)}%</span>`
        : `<span class="pl na" title="${h.entryPrice == null ? "אין מחיר עלות" : "אין מחיר"}">—</span>`;

    let status: string;
    if (r) {
      status = `<span class="badge ${recClass(r.recommendation)}">${esc(r.recommendation)}</span> <span class="pf-score">ציון ${r.score} ${deltaHtml(r.symbol, r.score, prevScores)}</span>`;
      const hz = horizons?.get(r.symbol);
      if (hz) {
        status += `<div class="pf-hz">שבועי ${hz.weeklyScore ?? "—"} · ארוך ${hz.longTerm?.label ?? "—"} · משולב <strong>${hz.combined}</strong>${hz.alignment === "מלאה" ? " 🚀" : ""}${hz.factor ? ` · פקטורים <strong>${hz.factor.score}</strong> (דירוג ${hz.factor.rank})` : ""}</div>${gradeHtml(hz.grades)}`;
      }
      if (r.risk) {
        status += `<div class="pf-risk">🎯 סטופ <strong>${fmt(r.risk.stop)}</strong> (${esc(r.risk.stopSource)}) · יעד ${fmt(r.risk.target)} · סיכוי/סיכון ${r.risk.rr.toFixed(1)}</div>`;
      }
      const delta = signalDeltas?.get(r.symbol);
      if (delta && (delta.added.length || delta.removed.length)) {
        const added = delta.added.slice(0, 3).map((s) => `<li class="add">➕ ${esc(s)}</li>`).join("");
        const removed = delta.removed.slice(0, 2).map((s) => `<li class="rem">➖ ${esc(s)}</li>`).join("");
        status += `<details class="pf-delta"><summary>מה השתנה מהדוח הקודם (${delta.added.length + delta.removed.length})</summary><ul>${added}${removed}</ul></details>`;
      }
      const check = checkBySymbol.get(r.symbol);
      if (check && Math.abs(check.deviationPct) > 2) {
        status += `<div class="pf-alert">⚠️ פער ${check.deviationPct.toFixed(1)}% מול אתר הבורסה (${fmt(check.tase)}) — לאמת לפני פעולה</div>`;
      }
    } else if (fundByName.has(h.name)) {
      const fv = fundByName.get(h.name)!;
      status = `<span class="badge ${recClass(FUND_ACTION_REC[fv.action])}">${esc(fv.action)}</span> <span class="pf-score">לפי ${esc(fv.indexName)}: ${esc(fv.analysis.recommendation)} · משולב <strong>${fv.horizon.combined}</strong></span>`
        + `<div class="pf-hz">ממוצע 150 ${signedPct(fv.method?.sma150Pct)} · ממוצע 200 ${signedPct(fv.trigger?.distancePct)}</div>`
        + `<ul class="signals">${fv.reasons.slice(0, 2).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
        + (fv.fund ? `<div class="pf-risk">🎯 סטופ לקרן ≈ <strong>${fmt(fv.fund.stop)}</strong> (-${fv.fund.riskPct.toFixed(1)}%) · יעד ≈ ${fmt(fv.fund.target)}</div>` : "");
    } else if (h.triggerIndex) {
      const idx = idxBySymbol.get(h.triggerIndex);
      const trigger = leverageTriggers?.get(h.triggerIndex);
      if (trigger) {
        const st = leverageStatus(trigger, idx?.name ?? h.triggerIndex);
        status = `<span class="pf-trigger ${st.ok ? "ok" : "warn"}">${st.ok ? "✅" : "⚠️"} ${esc(st.text)}</span>`;
      } else if (idx) {
        const ok = idx.indicators.trendUp;
        status = `<span class="badge ${stanceClass(idx.stance)}">${esc(idx.stance)}</span> <span class="pf-trigger ${ok ? "ok" : "warn"}">${ok ? `✅ ממוצע ${PARAMS.smaShort} מעל ${PARAMS.smaLong}` : `⚠️ ממוצע ${PARAMS.smaShort} מתחת ל-${PARAMS.smaLong}`} (${esc(idx.name)})</span>`;
      } else {
        status = `<span class="pf-trigger na">אין נתוני מדד ייחוס עדיין</span>`;
      }
    } else {
      const u = underlying?.find((x) => x.taseNumber === h.taseNumber);
      status = u
        ? `<span class="pf-trigger ${u.hit ? "warn" : "ok"}">${u.hit ? "⚠️" : "✅"} ${esc(underlyingText(u))}</span>`
        : `<span class="pf-trigger na">אין ניתוח טכני זמין</span>`;
    }

    if (!r) status += `<div class="coverage-note">${fundByName.has(h.name)
      ? `ניתוח לפי המדד, לא לפי מחיר הקרן; הסטופ לקרן הוא קירוב${(fundByName.get(h.name)!.leverage !== 1) ? " (מרחק במדד × המינוף)" : ""}.`
      : `${price != null ? "מחיר בלבד" : "מחיר חסר"}; ללא ציון או סטופ. מדד ייחוס אינו ניתוח של הקרן.`}</div>`;

    if (h.alertBelow != null && price != null && price < h.alertBelow) {
      status += `<div class="pf-alert">🚨 מתחת לרמת הבקרה (${h.alertBelow.toLocaleString("he-IL")}) — לשקול בחינה מחדש</div>`;
    }

    const chart = h.symbol ? sparkline(sparkCloses?.get(h.symbol), r?.risk?.stop ?? r?.sequenceStop ?? null) : "";

    return `<tr>
      <td class="name">${esc(h.name)}${h.core ? ` <span class="core-tag">ליבה</span>` : ""}${h.note ? ` <small>${esc(h.note)}</small>` : ""}</td>
      <td class="num">${h.entryPrice != null ? h.entryPrice.toLocaleString("he-IL", { maximumFractionDigits: 2 }) : `<span class="pl na" title="ללא מחיר עלות">—</span>`}</td>
      <td class="num">${price != null ? price.toLocaleString("he-IL", { maximumFractionDigits: 2 }) : "—"}${price != null ? `<div>${quoteChip(quoteStamps?.get(h.name), generatedAt)}</div>` : ""}</td>
      <td class="num">${plHtml}</td>
      <td class="spark-cell">${chart}</td>
      <td>${status}</td>
    </tr>`;
  }).join("\n");

  return `<section id="portfolio" class="portfolio">
    <h2>התיק שלי — בדיקה יומית</h2>
    <p class="note">מחירי ישראל באגורות; ניירות ארה"ב בדולר. מחיר זמין אינו מעיד על כיסוי טכני מלא.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>נייר</th><th>מחיר כניסה</th><th>מחיר נוכחי</th><th>רווח/הפסד</th><th>60 ימים</th><th>סטטוס / טריגר</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/** מקטע החזקות ליבה (למשל NVIDIA): כרטיס קבוע עם חוכמת המונים, כוכבים ואזור חיזוק. */
function renderCoreSection(results: AnalysisResult[], horizons?: Map<string, HorizonInfo>): string {
  const core = PORTFOLIO.filter((h) => h.core && h.symbol);
  if (!core.length) return "";
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));
  const cards = core.map((h) => {
    const hz = horizons?.get(h.symbol!);
    const zone = hz?.topUp?.zone ?? "none";
    return `<article class="core-card">
      <header><h3>${esc(h.name)} <small>${esc(h.symbol!)}</small></h3>${hz?.topUp ? `<span class="core-zone zone-${zone}">חיזוק: ${esc(hz.topUp.label)}</span>` : ""}</header>
      <ul>${coreHoldingLines(h, bySymbol.get(h.symbol!), hz).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
    </article>`;
  }).join("");
  return `<section id="core" class="core-holdings">
    <h2>ניתוח החזקות ליבה</h2>
    <div class="core-grid">${cards}</div>
    <p class="note">החזקות קבועות — הדוח לא ממליץ למכור אותן, רק מציג רמות לבחינה ואזור חיזוק. חוכמת המונים בסגנון TipRanks (אנליסטים, שינויי המלצות, מקורבים, מוסדיים); כוכבים בסגנון Morningstar — קירוב לפי יעד האנליסטים ופיזור היעדים, לא מודל שווי פנימי; RS בסגנון IBD. אזור החיזוק: מתוח מעל 10% מממוצע 50 או RSI 70+, טוב בתיקון לממוצע 50, ב-15% מתחת לשיא או ב-4 כוכבים ומעלה.</p>
  </section>`;
}

/** מצב שוק ורוחב שוק — מסנן-על שמעל כל ההמלצות. */
function renderRegimeSection(regime: MarketRegime | null | undefined): string {
  if (!regime) return "";
  const cls =
    regime.label === "ריסק-און" ? "rec-strong-buy" : regime.label === "ריסק-אוף" ? "rec-sell" : "rec-hold";
  return `<section class="regime">
    <h2>מצב שוק ורוחב שוק</h2>
    <div class="regime-head">
      <span class="badge ${cls}">${esc(regime.label)}</span>
      <span class="regime-score">ציון מצב ${regime.score}</span>
      <span class="regime-bench">${esc(regime.benchmarkName)} ${fmt(regime.price)}</span>
    </div>
    <div class="regime-metrics">
      <div><span>מעל ממוצע 50</span><strong>${regime.breadthPct.toFixed(0)}%</strong></div>
      <div><span>עולות / יורדות</span><strong>${regime.advancers} / ${regime.decliners}</strong></div>
      <div><span>שיאים / שפלים 52ש'</span><strong>${regime.newHighs} / ${regime.newLows}</strong></div>
      <div><span>מעל ממוצע 200</span><strong>${regime.aboveSma200 ? "כן" : "לא"}</strong></div>
    </div>
    <ul class="signals">${regime.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
  </section>`;
}

/** כרטיס ציונים — איך הצליחו ההמלצות היומיות הקודמות בפועל. */
function renderScorecardSection(scorecard: PickScorecard | undefined): string {
  if (!scorecard || !scorecard.count) return "";
  const rows = scorecard.outcomes
    .slice(0, 10)
    .map(
      (o) => `<tr>
        <td>${esc(o.date)}</td>
        <td class="name">${esc(o.name)} <small>${esc(o.symbol)}</small></td>
        <td class="num">${fmt(o.price)}</td>
        <td class="num">${fmt(o.currentPrice)}</td>
        <td class="num"><span class="pl ${o.returnPct >= 0 ? "up" : "down"}">${o.returnPct >= 0 ? "▲" : "▼"} ${Math.abs(o.returnPct).toFixed(1)}%</span></td>
        <td>${o.hitTarget ? "🎯 יעד" : o.hitStop ? "🛑 סטופ" : `${o.daysHeld} ימים`}</td>
      </tr>`
    )
    .join("");
  const hitClass = scorecard.hitRate >= 50 ? "up" : "down";
  return `<section class="scorecard">
    <h2>כרטיס ציונים — ביצועי ההמלצות הקודמות</h2>
    <div class="score-summary">
      <div><span>המלצות שנמדדו</span><strong>${scorecard.count}</strong></div>
      <div><span>אחוז מוצלחות</span><strong class="${hitClass}">${scorecard.hitRate.toFixed(0)}%</strong></div>
      <div><span>תשואה ממוצעת</span><strong class="${scorecard.avgReturn >= 0 ? "up" : "down"}">${scorecard.avgReturn >= 0 ? "+" : ""}${scorecard.avgReturn.toFixed(1)}%</strong></div>
      <div><span>הטובה ביותר</span><strong>${scorecard.best ? `${esc(scorecard.best.name)} ${scorecard.best.returnPct.toFixed(1)}%` : "—"}</strong></div>
      <div><span>הגרועה ביותר</span><strong>${scorecard.worst ? `${esc(scorecard.worst.name)} ${scorecard.worst.returnPct.toFixed(1)}%` : "—"}</strong></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>תאריך</th><th>המלצה</th><th>מחיר אז</th><th>מחיר היום</th><th>תשואה</th><th>סטטוס</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">התשואה מחושבת מיום ההמלצה ועד הדוח הנוכחי (עד 20 המלצות אחרונות) — מדד לאיכות המנוע, לא הבטחה.</p>
  </section>`;
}

/** ריכוזיות התיק — מתאמים גבוהים בין ההחזקות ובטא מול המדד. */
function renderCorrelationSection(
  correlations: CorrPair[] | undefined,
  betas: BetaEntry[] | undefined
): string {
  if ((!correlations || !correlations.length) && (!betas || !betas.length)) return "";
  const rows = (correlations ?? [])
    .slice(0, 8)
    .map((c) => {
      const level = Math.abs(c.corr) >= 0.85 ? "high" : Math.abs(c.corr) >= 0.7 ? "mid" : "low";
      return `<tr class="corr-${level}">
        <td class="name">${esc(c.nameA)}</td>
        <td class="name">${esc(c.nameB)}</td>
        <td class="num">${c.corr.toFixed(2)}</td>
        <td>${Math.abs(c.corr) >= 0.85 ? "כמעט אותה פוזיציה" : Math.abs(c.corr) >= 0.7 ? "חפיפה גבוהה" : "חפיפה בינונית"}</td>
      </tr>`;
    })
    .join("");
  const corrTable = rows
    ? `<div class="table-wrap">
      <table>
        <thead><tr><th>נייר א'</th><th>נייר ב'</th><th>מתאם (60 ימים)</th><th>משמעות</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
    : `<p class="empty">אין צמדי החזקות עם מתאם גבוה — הפיזור סביר.</p>`;
  const betaHtml = betas?.length
    ? `<div class="beta-list">${betas
        .map(
          (b) =>
            `<div><span>${esc(b.name)}</span><strong>β ${b.beta.toFixed(2)}</strong><small>${
              b.beta > 1.2 ? "תנודתית מהמדד" : b.beta < 0.8 ? "הגנתית מהמדד" : "נעה עם המדד"
            }</small></div>`
        )
        .join("")}</div>`
    : "";
  return `<section class="corr">
    <h2>ריכוזיות התיק — מתאם ובטא</h2>
    ${corrTable}
    ${betaHtml}
    <p class="note">מתאם מעל 0.7 = שתי ההחזקות נעות יחד; פיזור אמיתי מחייב נכסים עם מתאם נמוך. β מודד רגישות לתנועת המדד.</p>
  </section>`;
}

/** Exit-severity score and reasons for one analyzed holding (shared by the action board and sell section). */
function holdingSeverity(
  h: HoldingDef,
  r: AnalysisResult,
  hz: HorizonInfo | undefined,
  news?: Map<string, StockNews>
): { severity: number; reasons: string[] } {
    const reasons: string[] = [];
    let severity = 0;
    if (r.signals.some((s) => s.includes("שבירת רצף עולה"))) {
      severity += 3;
      reasons.push("🔔 שבירת רצף עולה (שיטת הרצפים) — איתות יציאה מובהק.");
    }
    if (r.signals.some((s) => s.includes("קרוס דובי"))) {
      severity += 2;
      reasons.push(`🔔 קרוס דובי — ממוצע ${PARAMS.smaShort} חצה מתחת לממוצע ${PARAMS.smaLong}.`);
    }
    if (r.recommendation === "הימנעות / מכירה") {
      severity += 3;
      reasons.push(`המלצת המנוע: הימנעות / מכירה (ציון יומי ${r.score}).`);
    } else if (r.score < 0) {
      severity += 2;
      reasons.push(`ציון יומי שלילי (${r.score}).`);
    } else if (r.score < 15) {
      severity += 1;
      reasons.push(`ציון יומי חלש (${r.score}) — התיזה הטכנית נחלשת.`);
    }
    if (hz && hz.combined < 0) {
      severity += 2;
      reasons.push(`ציון משולב שלילי (${hz.combined}) — חולשה בכל האופקים.`);
    } else if (hz?.longTerm?.label === "שלילי" && !r.indicators.trendUp) {
      severity += 1;
      reasons.push("מגמה ארוכת טווח שלילית יחד עם חולשה יומית.");
    }
    if (hz?.factor && hz.factor.rank < 30 && hz.factor.aboveSma200 === false) {
      severity += 2;
      reasons.push(`דירוג פקטורים נמוך (${hz.factor.rank}) והמחיר מתחת לממוצע 200.`);
    }
    if (h.alertBelow != null && r.price < h.alertBelow) {
      severity += 2;
      reasons.push(`🚨 מתחת לרמת הבקרה שהוגדרה (${h.alertBelow.toLocaleString("he-IL")}).`);
    }
    if (r.patterns.some((p) => p.bias === "bearish")) {
      severity += 1;
      reasons.push(`תבנית נר דובית: ${r.patterns.filter((p) => p.bias === "bearish").map((p) => p.name).join(", ")}.`);
    }
    if (r.divergence === "bearish") {
      severity += 2;
      reasons.push("🔔 דיברגנס שלילי מול RSI — המומנטום לא מאשר את השיא החדש.");
    }
    if (r.indicators.supertrendUp === false) {
      severity += 2;
      reasons.push("Supertrend שלילי — מבנה המגמה התהפך.");
    }
    if (r.signals.some((s) => s.includes("שבירת שפל"))) {
      severity += 2;
      reasons.push(`🔔 שבירת שפל ${PARAMS.donchianPeriod} ימים — חולשה מבנית.`);
    }
    if (r.risk && r.price < r.risk.stop) {
      severity += 3;
      reasons.push(`🚨 המחיר מתחת לסטופ המתוכנן (${fmt(r.risk.stop)}, ${esc(r.risk.stopSource)}).`);
    }
    const freshNeg = news?.get(r.symbol)?.freshNegative ?? [];
    if (freshNeg.length) {
      severity += 1;
      reasons.push(`📰 כותרת שלילית טרייה: "${freshNeg[0].title.slice(0, 90)}".`);
    }
    // מימוש רווח: פוזיציה רווחית ומתוחה קיצונית — לא איתות מכירה מלא אלא הקטנת סיכון
    const plPct = plPctOf(r.price, h.entryPrice);
    if (plPct != null && plPct > 8 && (r.indicators.stochK ?? 0) >= 90 && (r.indicators.rsi ?? 0) >= 68) {
      severity += 1;
      reasons.push(`רווח ${plPct.toFixed(1)}% עם מתיחות קיצונית (סטוכסטי ${r.indicators.stochK?.toFixed(0)}, RSI ${r.indicators.rsi?.toFixed(0)}) — לשקול מימוש חלקי.`);
    }
  return { severity, reasons };
}

/** Action level for a held position, from the same severity scale as the sell section. Core holdings are never told to exit. */
function holdingAction(severity: number, core = false): { label: string; cls: string } {
  if (core) return severity >= 3 ? { label: "ליבה · לבחינה", cls: "act-tight" } : { label: "ליבה · להחזיק", cls: "act-hold" };
  if (severity >= 5) return { label: "לצאת", cls: "act-exit" };
  if (severity >= 4) return { label: "לצמצם", cls: "act-reduce" };
  if (severity >= 3) return { label: "להדק סטופ", cls: "act-tight" };
  return { label: "להחזיק", cls: "act-hold" };
}

/** SMA200 trigger status for a leveraged/index holding (display only). */
function leverageStatus(trigger: LeverageTrigger, indexName: string): { label: string; cls: string; rank: number; text: string; ok: boolean } {
  const sign = trigger.distancePct >= 0 ? "+" : "";
  const text = `${indexName}: ${trigger.aboveSma200 ? "מעל" : "מתחת ל"}ממוצע 200 (${sign}${trigger.distancePct.toFixed(1)}%) · ירידה מהשיא ${trigger.drawdownPct.toFixed(1)}%${trigger.sma50BelowSma200 ? " · ממוצע 50 מתחת ל-200" : ""}`;
  if (!trigger.aboveSma200) return { label: "מתחת לממוצע 200", cls: "act-reduce", rank: 4, text, ok: false };
  if (trigger.warning) return { label: "אזהרה מוקדמת", cls: "act-tight", rank: 3, text, ok: false };
  return { label: "להחזיק", cls: "act-hold", rank: 0, text, ok: true };
}

function renderMacroSection(macro: MacroView | undefined): string {
  if (!macro) return "";
  const flags = macro.flags.length
    ? `<ul class="signals">${macro.flags.map((f) => `<li><strong>${esc(f.label)}</strong> — ${esc(f.detail)}</li>`).join("")}</ul>`
    : `<p class="empty">אין דגלי מאקרו פעילים (נפט, VIX, תשואות, שקל).</p>`;
  const examples = macro.geo.examples.length ? `<ul class="signals">${macro.geo.examples.map((e) => `<li>${esc(e.title)} <span class="meta">(${esc(e.source)})</span></li>`).join("")}</ul>` : "";
  const percentile = macro.geo.percentile != null ? ` · אחוזון <bdi>${macro.geo.percentile}</bdi> מול 60 הימים האחרונים` : " · אין עדיין 20 ימי היסטוריה להשוואה";
  return `<section class="macro">
    <h2>מאקרו וגאופוליטיקה</h2>
    ${flags}
    <p>עוצמת כותרות גאופוליטיות: <strong>${esc(macro.geo.level)}</strong> (${macro.geo.count} מתוך ${macro.geo.total} כותרות${percentile})</p>
    ${examples}
    <p class="note">הדגלים מוצגים להקשר ולהערת המלצת היום בלבד; הם אינם משנים ציוני מניות.</p>
  </section>`;
}

export function renderCreatorSection(view: CreatorView | undefined): string {
  if (!view) return "";
  const day = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric" }).format(d) : "";
  };
  const videos = view.videos.length
    ? `<ul class="signals">${view.videos.slice(0, 10).map((v) => `<li>${v.isNew ? "<strong>🆕</strong> " : ""}<bdi>${esc(day(v.published))}</bdi> · ${safeLink(v.url) ? `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a>` : esc(v.title)}${v.blurb ? `<div class="meta">${esc(v.blurb.slice(0, 220))}</div>` : ""}</li>`).join("")}</ul>`
    : `<p class="empty">לא התקבלו סרטונים מהשבוע האחרון (אין סרטונים חדשים, או שהמשיכה מיוטיוב נכשלה — ראו "בריאות הנתונים").</p>`;
  const num = (v: number | null) => (v == null ? "—" : `<bdi>${fmt(v)}</bdi>`);
  const rowHtml = (r: CreatorRow) => `<tr><td class="name">${esc(r.name)} <span class="meta">${esc(r.symbol)}</span>${r.held ? " ⭐" : ""}</td><td>${esc(SETUP_LABEL[r.setup.status])}</td><td class="num">${num(r.price)}</td><td class="num">${num(r.setup.trigger)}</td><td class="num">${num(r.setup.stop)}</td><td class="num">${num(r.setup.target)}</td><td class="num">${num(r.setup.rr)}</td><td class="num">${num(r.combined)}</td><td>${esc(r.verdict)}</td></tr>`;
  const table = (rows: CreatorRow[]) => `<div class="table-wrap"><table><thead><tr><th>נייר</th><th>מבנה</th><th>מחיר</th><th>טריגר</th><th>סטופ</th><th>יעד</th><th>סיכוי/סיכון</th><th>משולב</th><th>לפי השיטה</th></tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table></div>`;
  const rules = `<div class="table-wrap"><table><thead><tr><th>הכלל שלו</th><th>מקור</th><th>מה הוא עושה בדוח</th></tr></thead><tbody>${METHOD_RULES.map((r) => `<tr><td>${esc(r.rule)}</td><td class="meta">${esc(r.source)}</td><td>${esc(r.effect)}</td></tr>`).join("")}</tbody></table></div>`;
  const pct = (v: number | null) => (v == null ? "—" : `<bdi class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</bdi>`);
  const holdingRows = view.holdings.map((h) => `<tr><td class="name">${esc(h.name)} <span class="meta">${esc(h.id)}</span></td><td>${h.basis === "index" ? `מדד ייחוס ${esc(h.basisName ?? "")}` : "הגרף של הנייר"}</td><td class="num">${num(h.price)}</td><td class="num">${num(h.check.sma150)}</td><td class="num">${pct(h.check.sma150Pct)}</td><td>${esc(h.verdict)}</td></tr>`).join("");
  const holdings = view.holdings.length
    ? `<div class="table-wrap"><table><thead><tr><th>החזקה</th><th>נבדק לפי</th><th>מחיר / ערך המדד</th><th>ממוצע 150</th><th>מרחק</th><th>לפי הכללים שלו</th></tr></thead><tbody>${holdingRows}</tbody></table></div>`
    : `<p class="empty">אין נתוני מחיר להחזקות בהרצה זו.</p>`;
  return `<section id="creator" class="creator">
    <h2>${esc(view.channels.join(", "))} — עדכונים ושיטה</h2>
    <h3>הכללים שמופעלים על ההמלצות</h3>
    ${rules}
    <p class="note">מקור הכללים: תיאורי הסרטונים ביוטיוב (לא תמלול). מועמדת קנייה שנופלת על אחד מהם מופיעה ב"מועמדות שנפסלו" עם הסיבה.</p>
    <h3>ההחזקות שלי לפי הכללים</h3>
    ${holdings}
    ${view.holdingsWithoutData.length ? `<p class="note">ללא היסטוריית מחירים בהרצה זו: ${esc(view.holdingsWithoutData.join(", "))}</p>` : ""}
    ${view.concentration ? `<p class="note">⚠️ ריכוזיות: ${esc(view.concentration)}</p>` : ""}
    <p class="note">קרן נבדקת לפי מדד הייחוס שלה, לא לפי מחיר הקרן. בהחזקת ליבה השורה היא לבחינה בלבד, לא הוראת מכירה.</p>
    <h3>סרטונים מ-7 הימים האחרונים</h3>
    ${videos}
    <h3>ניירות שהוזכרו (⭐ = בתיק)</h3>
    ${view.mentions.length ? table(view.mentions) : `<p class="empty">לא זוהו אזכורים של ניירות עם נתוני מחיר.</p>`}
    ${view.otherMentions.length ? `<p class="note">הוזכרו גם (ללא נתוני מחיר בהרצה זו): ${esc(view.otherMentions.join(", "))}</p>` : ""}
    <h3>רשימת המעקב לפי השיטה שלו — שינוי מגמה (Edwards &amp; Magee)</h3>
    ${view.setups.length ? table(view.setups.slice(0, 20)) : `<p class="empty">אין מבני שינוי מגמה ברשימה.</p>`}
    <p class="note">מבנה = נפילה של 15%+ מהשיא, שפל עולה אחרי התחתית וקו שיאים יורדים. טריגר = השיא היורד האחרון; סטופ = מתחת לשפל העולה (חצי ATR); יעד = מהלך מדוד (גובה הבסיס מעל הטריגר), לכל היותר השיא הקודם. הכללים (לא נכנסים לפני דוח, חוק 3 הימים, לא רודפים) מסכמים את מה שהוא מלמד בערוץ; הזיהוי אוטומטי ואינו המלצה שלו. תוכן הסרטונים מוצג מתוך התיאור ביוטיוב בלבד.</p>
  </section>`;
}

function renderExposureSection(rows: SensitivityRow[] | undefined): string {
  if (!rows?.length) return "";
  const cell = (v: number | null) => (v == null ? "—" : `<bdi class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</bdi>`);
  const body = rows.map((r) => `<tr><td class="name">${esc(r.name)}${r.leverage !== 1 ? ` <span class="meta">(×${r.leverage})</span>` : ""}</td><td class="num">${cell(r.brentUp10)}</td><td class="num">${cell(r.ndxDown5)}</td><td class="num">${cell(r.ta35Down5)}</td><td class="num">${cell(r.usdUp3)}</td></tr>`).join("");
  return `<section class="exposure">
    <h2>רגישות התיק לתרחישים</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>החזקה</th><th>ברנט +10%</th><th>נאסד"ק 100 −5%</th><th>ת"א 35 −5%</th><th>דולר-שקל +3%</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="note">תנועה משוערת של כל החזקה לפי בטא של 60 ימי מסחר מול כל גורם בנפרד (לא מצטבר). לקרן שאינה מנותחת משמש מדד הייחוס, כפול המינוף שלה. הערכה סטטיסטית, לא תחזית.</p>
  </section>`;
}

/**
 * המלצות מכירה — התראות יציאה על ההחזקות בתיק (מנוקדות לפי חומרה) ואיתותי מכירה טריים
 * במניות שבמעקב. קרנות סל ממונפות אינן נכללות כאן — עבורן מוצג מעקב טריגרים בלבד.
 */
export function holdingSellAlerts(
  results: AnalysisResult[],
  horizons?: Map<string, HorizonInfo>,
  news?: Map<string, StockNews>
): { name: string; symbol: string; price: number; severity: number; reasons: string[]; stop: number | null; core: boolean }[] {
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));

  type Alert = { name: string; symbol: string; price: number; severity: number; reasons: string[]; stop: number | null; core: boolean };
  const held: Alert[] = [];

  for (const h of PORTFOLIO) {
    if (!h.symbol) continue;
    const r = bySymbol.get(h.symbol);
    if (!r) continue;
    const { severity, reasons } = holdingSeverity(h, r, horizons?.get(r.symbol), news);
    if (severity > 0) held.push({ name: h.name, symbol: r.symbol, price: r.price, severity, reasons, stop: r.risk?.stop ?? r.sequenceStop, core: h.core === true });
  }

  held.sort((a, b) => b.severity - a.severity);

  return held;
}

function renderSellSection(
  results: AnalysisResult[],
  horizons?: Map<string, HorizonInfo>,
  news?: Map<string, StockNews>
): string {
  const held = holdingSellAlerts(results, horizons, news).filter(alert => alert.severity >= 3);

  const heldHtml = held.length
    ? held
        .map((a) => {
          const level = a.core ? "החזקת ליבה — רמות לבחינה" : a.severity >= 5 ? "מכירה / יציאה" : a.severity >= 4 ? "צמצום פוזיציה" : "סטופ הדוק";
          const cls = a.core ? "sell-watch" : a.severity >= 5 ? "sell-urgent" : a.severity >= 4 ? "sell-reduce" : "sell-watch";
          const stopLine = a.stop == null
            ? ""
            : a.core
            ? `<p class="sell-stop">רמה לבחינה: <strong>${a.stop.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</strong> — החזקת ליבה קבועה; לא המלצת מכירה.</p>`
            : `<p class="sell-stop">רמת יציאה: <strong>${a.stop.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</strong> — סגירה מתחתיה = יציאה.</p>`;
          return `<article class="sell-card ${cls}">
            <header>
              <span class="sell-level">${level}</span>
              <h3>${esc(a.name)} <small>${esc(a.symbol)}</small></h3>
              <span class="sell-price">מחיר ${a.price.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</span>
            </header>
            <ul class="signals">${a.reasons.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
            ${stopLine}
          </article>`;
        })
        .join("\n")
    : `<p class="empty">לא זוהתה התראת מכירה לפי סף החומרה בהחזקות שנותחו. אין בכך אישור שכל ההחזקות מעל סטופ; החזקות ללא ניתוח אינן מכוסות.</p>`;

  const heldSyms = new Set(PORTFOLIO.map((h) => h.symbol).filter((s): s is string => !!s));
  const watchSells = results
    .filter((r) => !heldSyms.has(r.symbol))
    .filter(
      (r) =>
        r.signals.some((s) => s.includes("שבירת רצף עולה") || s.includes("קרוס דובי")) &&
        r.score < 0
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  const watchHtml = watchSells.length
    ? `<div class="sell-watchlist"><h4>איתותי מכירה טריים במניות שבמעקב (להימנעות מקנייה)</h4><ul>${watchSells
        .map(
          (r) =>
            `<li><strong>${esc(r.name)}</strong> <small>${esc(r.symbol)}</small> — ציון ${r.score} · ${esc(
              r.signals.find((s) => s.includes("שבירת רצף עולה") || s.includes("קרוס דובי")) ?? ""
            )}</li>`
        )
        .join("")}</ul></div>`
    : "";

  return `<section id="alerts" class="sell">
    <h2>המלצות מכירה / יציאה</h2>
    ${heldHtml}
    ${watchHtml}
  </section>`;
}

const FUND_ACTION_REC: Record<FundAction, string> = { "קנייה / חיזוק": "קנייה", "החזקה": "החזקה", "צמצום / מכירה": "הימנעות / מכירה" };
const signedPct = (v: number | null | undefined): string => (v == null ? "—" : `<bdi class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</bdi>`);

/** The funds read through their reference index: full engine on the index, decision and fund-equivalent levels. */
export function renderFundIndexSection(views: FundIndexView[] | undefined): string {
  if (!views?.length) return "";
  const rows = views.map((v) => {
    const a = v.analysis;
    const hz = v.horizon;
    const levels = v.fund
      ? `סטופ ≈ <bdi>${fmt(v.fund.stop)}</bdi> (<bdi>-${v.fund.riskPct.toFixed(1)}%</bdi>) · יעד ≈ <bdi>${fmt(v.fund.target)}</bdi> (<bdi>+${v.fund.rewardPct.toFixed(1)}%</bdi>)`
      : "—";
    const indexLevels = a.risk ? `סטופ <bdi>${fmt(a.risk.stop)}</bdi> · יעד <bdi>${fmt(a.risk.target)}</bdi> · סיכוי/סיכון ${a.risk.rr.toFixed(1)}` : "—";
    const sma200Pct = v.sma200 ? ((a.price / v.sma200 - 1) * 100) : null;
    return `<tr>
      <td class="name">${esc(v.name)} <span class="meta">${esc(v.id)}</span>${v.leverage !== 1 ? ` <span class="meta">(×${v.leverage})</span>` : ""}</td>
      <td>${esc(v.indexName)} <span class="meta">${esc(v.indexSymbol)}</span>${v.historySymbol !== v.indexSymbol ? `<div class="meta">היסטוריה: ${esc(v.historySymbol)}</div>` : ""}</td>
      <td><span class="badge ${recClass(FUND_ACTION_REC[v.action])}">${esc(v.action)}</span></td>
      <td class="num"><bdi>${fmt(a.price)}</bdi></td>
      <td>יומי <strong>${a.score}</strong> · שבועי <strong>${hz.weeklyScore ?? "—"}</strong> · ארוך ${ltBadge(hz.longTerm)} · משולב <strong>${hz.combined}</strong><div class="meta">${esc(a.recommendation)}</div></td>
      <td>150: ${signedPct(v.method?.sma150Pct)} · 200: ${signedPct(sma200Pct)}</td>
      <td>${indexLevels}</td>
      <td>${levels}</td>
      <td><ul class="signals">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></td>
    </tr>`;
  }).join("");
  const notes = [...new Set(views.flatMap((v) => (v.historyNote ? [v.historyNote] : [])))];
  return `<section id="funds" class="funds">
    <h2>הקרנות שלי — ניתוח לפי המדד</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>קרן</th><th>מדד</th><th>פעולה</th><th>המדד</th><th>ציונים</th><th>מרחק מממוצע</th><th>סטופ ויעד למדד</th><th>סטופ ויעד לקרן (≈)</th><th>למה</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">המנוע המלא (יומי, שבועי, ארוך טווח, כללי מיכה סטוקס) רץ על נרות המדד. צמצום: קרן ממונפת כשהמדד מתחת לממוצע 200, או מדד מתחת לממוצע 150 שחלש בכל האופקים. חיזוק: המלצת קנייה למדד, משולב ${FUND_BUY_MIN_COMBINED}+, אף כלל לא חוסם, ובממונפת גם מעל ממוצע 200 ובלי ריסק-אוף. הסטופ והיעד לקרן = המרחק במדד כפול המינוף — קירוב, כי קרן ממונפת מתאזנת כל יום.</p>
    ${notes.map((n) => `<p class="note">${esc(n)}.</p>`).join("")}
  </section>`;
}

/** Buy and sell lists per exchange, each judged by its own market regime. */
export function renderMarketRecsSection(input: ReportHtmlInput): string {
  if (!input.horizons?.size) return "";
  const blocks = marketRecommendations(input).map((m) => {
    const regime = m.regime ? `<p class="pick-regime">🧭 מצב שוק ${esc(m.label)}: <strong>${esc(m.regime.label)}</strong> (ציון ${m.regime.score}, רוחב ${m.regime.breadthPct.toFixed(0)}%) · לפי ${esc(m.regime.benchmarkName)}</p>` : "";
    const candidate = (x: { r: AnalysisResult; hz: HorizonInfo }, label: string) => `<li><span class="meta">${label}</span> <strong>${esc(x.r.name)}</strong> <small>${esc(x.r.symbol)}</small> · מחיר <bdi>${fmt(x.r.price)}</bdi> · משולב ${x.hz.combined}${x.hz.factor ? ` · דירוג פקטורים ${x.hz.factor.rank}` : ""}${x.r.risk ? ` · סטופ <bdi>${fmt(x.r.risk.stop)}</bdi> · יעד <bdi>${fmt(x.r.risk.target)}</bdi> · סיכוי/סיכון ${x.r.risk.rr.toFixed(1)}` : ""}</li>`;
    const buys = [
      ...(m.pick.main ? [candidate(m.pick.main, "ראשונה")] : []),
      ...m.pick.alts.map((x) => candidate(x, "חלופה")),
      ...(m.strengthen ? [candidate(m.strengthen, "חיזוק החזקה")] : []),
      ...m.fundBuys.map((f) => `<li><span class="meta">חיזוק קרן</span> <strong>${esc(f.name)}</strong> · לפי ${esc(f.indexName)} · ${esc(f.reasons[0] ?? "")}${f.fund ? ` · סטופ ≈ <bdi>${fmt(f.fund.stop)}</bdi>` : ""}</li>`),
    ];
    const sells = m.sells.map((s) => `<li><span class="meta">${esc(s.action)}</span> <strong>${esc(s.name)}</strong> <small>${esc(s.id)}</small>${s.price != null ? ` · מחיר <bdi>${fmt(s.price)}</bdi>` : ""}${s.level != null ? ` · רמת יציאה <bdi>${fmt(s.level)}</bdi>` : ""} — ${esc(s.reasons.join("; "))}</li>`);
    const avoid = m.avoid.map((a) => `<li><strong>${esc(a.name)}</strong> <small>${esc(a.symbol)}</small> · ציון ${a.score} — ${esc(a.reason)}</li>`);
    const rejected = m.pick.rejected.length
      ? `<details class="pick-rejected"><summary>נפסלו (${m.pick.rejected.length})</summary><ul>${m.pick.rejected.map((x) => `<li><strong>${esc(x.name)}</strong> <small>${esc(x.symbol)}</small> — ${esc(x.reason)}</li>`).join("")}</ul></details>`
      : "";
    return `<article class="market-recs">
      <h3>${esc(m.label)} <span class="meta">${m.analyzed ? `${m.analyzed} ניירות נותחו` : "קרנות לפי מדד"}</span></h3>
      ${regime}
      <h4>קנייה</h4>
      ${buys.length ? `<ul class="signals">${buys.join("")}</ul>` : `<p class="empty">אין מועמדת שעוברת את מסנני האיכות וכללי מיכה סטוקס — עדיף להמתין.</p>`}
      ${rejected}
      <h4>מכירה / צמצום בתיק</h4>
      ${sells.length ? `<ul class="signals">${sells.join("")}</ul>` : `<p class="empty">אין החזקה בבורסה הזו עם התראת יציאה לפי סף המנוע.</p>`}
      ${avoid.length ? `<h4>להימנע מקנייה (איתות מכירה טרי)</h4><ul class="signals">${avoid.join("")}</ul>` : ""}
    </article>`;
  }).join("");
  return `<section id="markets" class="markets">
    <h2>המלצות לפי בורסה — תל אביב וארה"ב</h2>
    <div class="market-grid">${blocks}</div>
    <p class="note">כל בורסה נבחנת לפי מצב השוק שלה (ת"א 125 / S&P 500 ורוחב השוק המקומי). אותם מסננים כמו המלצת היום: נזילות, ציון, סיכוי/סיכון 1.5+, דגלים אדומים וכללי מיכה סטוקס. קרן מופיעה בבורסה של המדד שלה. אין זו הוראת מסחר.</p>
  </section>`;
}

/** המלצת הרכישה היומית — המועמדות הטובות ביותר בשקלול שלושת האופקים, עם התחשבות בחפיפה לתיק. */
function renderDailyPickSection(
  results: AnalysisResult[],
  horizons?: Map<string, HorizonInfo>,
  regime?: MarketRegime | null,
  news?: Map<string, StockNews>
): string {
  if (!horizons || horizons.size === 0) return "";
  const sel = selectDailyPick(results, horizons, regime);

  const overlapNote = (sym: string): string => {
    const sector = STOCK_SECTORS[sym];
    return sector && HELD_SECTORS.includes(sector)
      ? `<div class="pick-overlap">⚠️ חפיפה סקטוריאלית: התיק כבר חשוף לסקטור ה${esc(sector)}</div>`
      : "";
  };

  const breakdown = (x: { r: AnalysisResult; hz: HorizonInfo }): string => {
    const stars = starRating(x.r.price, x.hz.crowd);
    return `יומי <strong>${x.r.score}</strong> · שבועי <strong>${x.hz.weeklyScore ?? "—"}</strong> · ארוך ${ltBadge(x.hz.longTerm)}${x.hz.factor ? ` · פקטורים <strong>${x.hz.factor.score}</strong> (דירוג ${x.hz.factor.rank})` : ""}${x.hz.rs != null ? ` · RS <strong>${x.hz.rs}</strong>` : ""}${stars ? ` · <span class="stars" title="בסגנון Morningstar: מחיר מול יעד האנליסטים, אי-ודאות ${stars.uncertainty}">${starText(stars.stars)}</span>` : ""} · התכנסות: ${x.hz.alignment}${x.hz.alignment === "מלאה" ? " 🚀" : ""}${x.hz.extended ? `<div class="pick-overlap">⚠️ מתוח ${x.hz.extended.pct.toFixed(1)}% מעל נקודת הפריצה (${fmt(x.hz.extended.pivot)}) — כלל IBD: לא לרדוף מעל 5%, לחכות לתיקון</div>` : ""}`;
  };

  /** טבלת ניהול הסיכון של ההמלצה: כניסה, סטופ, יעד, יחס וגודל פוזיציה. */
  const riskBox = (r: AnalysisResult): string => {
    if (!r.risk) return "";
    const size = r.size;
    return `<div class="risk-box">
      <div><span>כניסה</span><strong>${fmt(r.price)}</strong></div>
      <div><span>סטופ (${esc(r.risk.stopSource)})</span><strong class="down">${fmt(r.risk.stop)}</strong><small>-${r.risk.riskPct.toFixed(1)}%</small></div>
      <div><span>יעד (${esc(r.risk.targetSource)})</span><strong class="up">${fmt(r.risk.target)}</strong></div>
      <div><span>סיכוי/סיכון</span><strong>${r.risk.rr.toFixed(1)} : 1</strong></div>
      ${
        size
          ? `<div><span>גודל פוזיציה</span><strong>${size.shares.toLocaleString("he-IL")} מניות</strong><small>≈ ₪${fmt(size.cost, 0)} · סיכון ₪${fmt(size.riskAmount, 0)} (${size.riskPerTradePct}% מהון ₪${fmt(size.capital, 0)})</small></div>`
          : ""
      }
    </div>`;
  };

  const regimeNote = sel.regimeNote
    ? `<p class="pick-regime">🧭 ${esc(sel.regimeNote)}</p>`
    : "";

  let mainHtml: string;
  if (sel.main) {
    const m = sel.main;
    const topSignals = [...m.r.signals.slice(0, 4), ...(m.hz.longTerm?.signals.slice(0, 2) ?? [])]
      .map((s) => `<li>${esc(s)}</li>`)
      .join("");
    const rsNote = m.r.relativeStrength
      ? `<div class="pick-rs">חוזק יחסי מול המדד: ${m.r.relativeStrength.excessPct >= 0 ? "+" : ""}${m.r.relativeStrength.excessPct.toFixed(1)}%</div>`
      : "";
    mainHtml = `<div class="pick-main">
      <div class="pick-head">
        <span class="pick-label">הבחירה של היום</span>
        <h3>${esc(m.r.name)} <small>${esc(m.r.symbol)}</small></h3>
        <span class="pick-combined">משולב ${m.hz.combined}</span>
      </div>
      <p class="pick-breakdown">${breakdown(m)} · מחיר ${fmt(m.r.price)}</p>
      ${gradeHtml(m.hz.grades)}
      ${overlapNote(m.r.symbol)}
      ${rsNote}
      ${m.hz.method ? `<div class="pick-rs">✅ עברה את כללי מיכה סטוקס: ${esc(methodPassLine(m.hz.method))}</div>` : ""}
      ${riskBox(m.r)}
      <ul class="signals">${topSignals}</ul>
    </div>`;
  } else {
    mainHtml = `<p class="empty">אף מועמדת לא עוברת היום את ספי האיכות (משולב ≥${sel.threshold}, יומי ≥15, נזילות גבוהה, יחס סיכוי/סיכון ≥${RISK.minRR}) ואת כללי מיכה סטוקס (דוח בתוך 7 ימים, חוק 3 הימים, ממוצע 150) — עדיף להמתין ולא לכפות קנייה.</p>`;
  }

  const altsHtml = sel.alts.length
    ? `<div class="pick-alts"><h4>חלופות נוספות</h4><ul>${sel.alts
        .map(
          (x) =>
            `<li><strong>${esc(x.r.name)}</strong> <small>${esc(x.r.symbol)}</small> — ${breakdown(x)}${
              x.r.risk ? ` · סטופ ${fmt(x.r.risk.stop)} · סיכוי/סיכון ${x.r.risk.rr.toFixed(1)}` : ""
            }${gradeHtml(x.hz.grades)}${overlapNote(x.r.symbol)}</li>`
        )
        .join("")}</ul></div>`
    : "";

  const strengthenHtml = sel.strengthen && !holdingSellAlerts(results, horizons, news).some(alert => alert.symbol === sel.strengthen?.r.symbol)
    ? `<p class="pick-strength">💪 חיזוק החזקה קיימת: <strong>${esc(sel.strengthen.r.name)}</strong> — ${breakdown(sel.strengthen)}</p>`
    : "";

  const rejectedHtml = sel.rejected.length
    ? `<details class="pick-rejected"><summary>מועמדות שנפסלו על ניהול סיכון וכללי מיכה סטוקס (${sel.rejected.length})</summary><ul>${sel.rejected
        .map((x) => `<li><strong>${esc(x.name)}</strong> <small>${esc(x.symbol)}</small> — ${esc(x.reason)}</li>`)
        .join("")}</ul></details>`
    : "";

  return `<section class="pick">
    <h2>המלצת הרכישה של היום</h2>
    ${regimeNote}
    ${mainHtml}
    ${altsHtml}
    ${strengthenHtml}
    ${rejectedHtml}
  </section>`;
}

const REGION_ORDER = ['ארה"ב', "ישראל", "אירופה", "אסיה"];

function forecastDirClass(dir: ForecastDirection): string {
  switch (dir) {
    case "עלייה":
      return "rec-strong-buy";
    case "נטייה לעלייה":
      return "rec-buy";
    case "יציבות / דשדוש":
      return "rec-hold";
    case "נטייה לירידה":
      return "rec-sell";
    default:
      return "rec-sell";
  }
}

function dirArrow(dir: ForecastDirection): string {
  switch (dir) {
    case "עלייה":
      return "🔼";
    case "נטייה לעלייה":
      return "↗️";
    case "יציבות / דשדוש":
      return "➡️";
    case "נטייה לירידה":
      return "↘️";
    default:
      return "🔽";
  }
}

/** מפיק את מקטע תחזית האייג'נט לבורסת ת"א ולנאסד"ק (יומי/שבועי). */
function renderForecastSection(forecast: ForecastResult): string {
  if (!forecast.markets.length) return "";

  const cards = forecast.markets
    .map((m) => {
      const reasons = m.reasoning.map((r) => `<li>${esc(r)}</li>`).join("");
      const watch = m.watchpoints.map((w) => `<li>${esc(w.replace("רוגע יחסי בשווקים, פחות סיכון לזעזועים", "תנודתיות גלומה נמוכה כעת; אין בכך לשלול זעזועים"))}</li>`).join("");
      return `<article class="fc-card">
        <div class="fc-head">
          <h3>${esc(m.market)}</h3>
          <span class="badge ${forecastDirClass(m.direction)}">${dirArrow(
        m.direction
      )} ${esc(m.direction)}</span>
        </div>
        <p class="fc-horizon">תחזית ל${esc(m.horizon)} · ציון מצרפי ${m.score}</p>
        <div class="fc-block">
          <h4>נימוק הניתוח</h4>
          <ul>${reasons}</ul>
        </div>
        <div class="fc-block">
          <h4>גורמים למעקב</h4>
          <ul>${watch}</ul>
        </div>
      </article>`;
    })
    .join("");

  return `<section class="forecast">
    <h2>תחזית האייג'נט — הערכה היוריסטית ל${esc(forecast.horizon)}</h2>
    <p class="fc-intro">${esc(forecast.summary)} <span class="fc-tone">${esc(
    forecast.newsTone.label
  )}</span></p>
    <div class="fc-cards">${cards}</div>
    <p class="fc-note">הציון המצרפי הוא הערכה היוריסטית של טכניקה וסנטימנט, לא הסתברות ולא תחזית תשואה. הוא נפרד מהראיות ההיסטוריות הניסיוניות ואינו ייעוץ השקעות.</p>
  </section>`;
}

/** מפיק את מקטע סקירת מדדי העולם (ארה"ב, ישראל, אירופה, אסיה). */
function renderIndicesSection(indices: IndexAnalysis[], historicalForecasts?: Map<string, HistoricalForecast>, sparkCloses?: Map<string, number[]>): string {
  if (!indices.length) return "";

  const groups = new Map<string, IndexAnalysis[]>();
  for (const idx of indices) {
    if (!groups.has(idx.region)) groups.set(idx.region, []);
    groups.get(idx.region)!.push(idx);
  }

  const regions = [...groups.keys()].sort(
    (a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b)
  );

  const blocks = regions
    .map((region) => {
      const list = groups
        .get(region)!
        .sort((a, b) => b.score - a.score);
      const cards = list
        .map((idx) => {
          const chg =
            idx.changePct != null
              ? `<span class="idx-chg ${
                  idx.changePct >= 0 ? "up" : "down"
                }">${idx.changePct >= 0 ? "▲" : "▼"} ${Math.abs(
                  idx.changePct
                ).toFixed(2)}%</span>`
              : "";
          const sigs = idx.signals
            .slice(0, 4)
            .map((s) => `<li>${esc(s)}</li>`)
            .join("");
          return `<article class="idx-card">
            <div class="idx-head">
              <h4>${esc(idx.name)} <small>${esc(idx.symbol)}</small></h4>
              <span class="badge ${stanceClass(idx.stance)}">${esc(idx.stance)}</span>
            </div>
            <div class="idx-row">
              <span class="idx-price">${idx.price.toLocaleString("he-IL", {
                maximumFractionDigits: 2,
              })}</span>
              ${chg}
              <span class="idx-score">ציון ${idx.score}</span>
            </div>
            ${sparkline(sparkCloses?.get(idx.symbol))}
            <div class="idx-rec">📌 ${esc(idx.recommendation)}</div>
            <div class="idx-metrics">
              <span>RSI ${idx.indicators.rsi?.toFixed(0) ?? "-"}</span>
              <span>ADX ${idx.indicators.adx?.toFixed(0) ?? "-"}</span>
              <span>ROC ${
                idx.indicators.roc != null ? idx.indicators.roc.toFixed(1) + "%" : "-"
              }</span>
              <span>מגמה ${idx.indicators.trendUp ? "⬆️" : "⬇️"}</span>
            </div>
            <ul class="idx-signals">${sigs}</ul>
            <details class="index-evidence"><summary>ראיות היסטוריות למדד</summary>${renderHistoricalEvidence(historicalForecasts?.get(idx.symbol))}</details>
          </article>`;
        })
        .join("");
      return `<div class="idx-region">
        <h3>${esc(region)}</h3>
        <div class="idx-cards">${cards}</div>
      </div>`;
    })
    .join("");

  return `<section>
    <h2>סקירת מדדי עולם והמלצות מגמה</h2>
    <p class="idx-intro">ניתוח טכני של מדדי מניות מובילים — ארה"ב, ישראל, אירופה (DAX) ואסיה. ההמלצות מתייחסות למגמת המדד ולא לנייר בודד.</p>
    ${blocks}
  </section>`;
}

/** מפיק מסמך HTML עצמאי ומעוצב עבור דוח בודד. */
export function renderReportHtml(input: ReportHtmlInput): string {
  const summary = input.summary ?? buildReportSummarySnapshot(input);
  const summaryJson = JSON.stringify(summary).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const {
    mode,
    results,
    indices,
    newsByStock,
    forecast,
    generatedAt,
    prevScores,
    extraPrices,
    horizons,
    regime,
    correlations,
    betas,
    priceChecks,
    sparkCloses,
    scorecard,
    signalDeltas,
    historicalForecasts,
    quoteStamps,
  } = input;
  const hasHz = !!horizons && horizons.size > 0;
  const title = mode === "daily"
    ? (hasHz ? "דוח משולב — יומי · שבועי · ארוך טווח" : "דוח המלצות יומי")
    : "דוח המלצות שבועי";
  const hzOf = (sym: string) => horizons?.get(sym);
  const hybridActive = !!horizons && [...horizons.values()].some((h) => h.engine === "hybrid");
  // מיון לפי ציון הפקטורים (מנוע היברידי) או המשולב, אחרת לפי הציון היומי
  const sortKey = (r: AnalysisResult) => hzOf(r.symbol)?.ranking ?? hzOf(r.symbol)?.combined ?? r.score;
  const sorted = [...results].sort((a, b) => sortKey(b) - sortKey(a));

  const indicesHtml = renderIndicesSection(indices, historicalForecasts, sparkCloses);
  const forecastHtml = renderForecastSection(forecast);
  const regimeHtml = renderRegimeSection(regime);
  const portfolioHtml = renderPortfolioSection(
    results,
    indices,
    prevScores,
    extraPrices,
    horizons,
    sparkCloses,
    signalDeltas,
    priceChecks,
    quoteStamps,
    generatedAt,
    input.leverageTriggers,
    input.macro?.underlying,
    input.fundViews
  );
  const pickHtml = renderDailyPickSection(results, horizons, regime, newsByStock);
  const sellHtml = renderSellSection(results, horizons, newsByStock);
  const scorecardHtml = renderScorecardSection(scorecard);
  const corrHtml = renderCorrelationSection(correlations, betas);

  const buys = sorted.filter(
    (r) => r.recommendation === "קנייה חזקה" || r.recommendation === "קנייה"
  );

  const tableRows = sorted
    .map((r, i) => {
      const trend = r.indicators.trendUp ? "⬆️" : "⬇️";
      const newsSent =
        r.newsSentiment > 0 ? "➕" : r.newsSentiment < 0 ? "➖" : "•";
      const hz = hzOf(r.symbol);
      const hzCells = hasHz
        ? `<td class="num">${hz?.weeklyScore ?? "—"}</td>
        <td class="center">${ltBadge(hz?.longTerm ?? null)}</td>
        <td class="num"><strong>${hz?.combined ?? "—"}</strong></td>
        <td class="num" title="${hz?.factor ? `דירוג ${hz.factor.rank}` : ""}">${hz?.factor?.score ?? "—"}</td>
        <td class="center grades-cell" title="${hz?.grades ? esc(gradeChips(hz.grades)) : ""}"><bdi dir="ltr">${gradeLetters(hz?.grades)}</bdi>${hz?.grades?.redFlags.length ? " 🚩" : ""}</td>`
        : "";
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td class="name">${esc(r.name)}</td>
        <td class="sym">${esc(r.symbol)}</td>
        <td class="num">${r.price.toFixed(2)}</td>
        <td class="num"><span class="score">${r.score}</span></td>
        <td class="num">${deltaHtml(r.symbol, r.score, prevScores) || '<span class="delta na">—</span>'}</td>
        ${hzCells}
        <td><span class="badge ${recClass(r.recommendation)}">${esc(r.recommendation)}</span></td>
        <td class="num">${r.indicators.rsi?.toFixed(0) ?? "-"}</td>
        <td class="num">${r.indicators.stochK?.toFixed(0) ?? "-"}</td>
        <td class="num">${r.indicators.adx?.toFixed(0) ?? "-"}</td>
        <td class="center">${trend}</td>
        <td class="center">${newsSent}</td>
      </tr>`;
    })
    .join("\n");

  const buyCards = buys.length
    ? buys
        .map((r) => {
          const news = newsByStock.get(r.symbol);
          const newsHtml =
            news && news.items.length
              ? `<div class="news"><span class="news-title">כתבות רלוונטיות:</span><ul>${news.items
                  .slice(0, 5)
                  .map(
                    (n) =>
                      `<li>${
                        safeLink(n.link)
                          ? `<a href="${esc(n.link!)}" target="_blank" rel="noopener noreferrer">${esc(
                              n.title
                            )}</a>`
                          : esc(n.title)
                      } <em>${esc(n.source)}</em></li>`
                  )
                  .join("")}</ul></div>`
              : "";
          const signals = r.signals.map((s) => `<li>${esc(s)}</li>`).join("");
          return `<article class="card">
            <header class="card-head">
              <span class="badge ${recClass(r.recommendation)}">${esc(r.recommendation)}</span>
              <h3>${esc(r.name)} <small>${esc(r.symbol)}</small></h3>
              <span class="card-score">ציון ${r.score} ${deltaHtml(r.symbol, r.score, prevScores)}</span>
            </header>
            <div class="metrics">
              <div><span>מחיר</span><strong>${r.price.toFixed(2)}</strong></div>
              <div><span>RSI</span><strong>${r.indicators.rsi?.toFixed(0) ?? "-"}</strong></div>
              <div><span>%B</span><strong>${
                r.indicators.percentB != null
                  ? (r.indicators.percentB * 100).toFixed(0) + "%"
                  : "-"
              }</strong></div>
              <div><span>MACD-hist</span><strong>${
                r.indicators.macdHist?.toFixed(3) ?? "-"
              }</strong></div>
              <div><span>Stoch %K</span><strong>${
                r.indicators.stochK?.toFixed(0) ?? "-"
              }</strong></div>
              <div><span>Williams %R</span><strong>${
                r.indicators.williamsR?.toFixed(0) ?? "-"
              }</strong></div>
              <div><span>ADX</span><strong>${
                r.indicators.adx?.toFixed(0) ?? "-"
              }</strong></div>
              <div><span>ATR</span><strong>${
                r.indicators.atrPct != null
                  ? r.indicators.atrPct.toFixed(1) + "%"
                  : "-"
              }</strong></div>
              <div><span>P/E</span><strong>${
                (r.fundamentals?.trailingPE ?? r.fundamentals?.forwardPE)?.toFixed(1) ?? "-"
              }</strong></div>
              <div><span>צמיחת רווחים</span><strong>${
                r.fundamentals?.earningsGrowth != null
                  ? (r.fundamentals.earningsGrowth * 100).toFixed(0) + "%"
                  : "-"
              }</strong></div>
              <div><span>דיבידנד</span><strong>${
                r.fundamentals?.dividendYield != null
                  ? (r.fundamentals.dividendYield * 100).toFixed(1) + "%"
                  : "-"
              }</strong></div>
              <div><span>P/B</span><strong>${
                r.fundamentals?.priceToBook?.toFixed(2) ?? "-"
              }</strong></div>
            </div>
            <ul class="signals">${signals}</ul>
            ${newsHtml}
          </article>`;
        })
        .join("\n")
    : `<p class="empty">לא נמצאו מניות שעוברות את סף הקנייה בהרצה זו.</p>`;

  const detailRows = sorted
    .map(
      (r) => `<details class="detail">
        <summary><span class="badge ${recClass(r.recommendation)}">${esc(
        r.recommendation
      )}</span> ${esc(r.name)} <small>${esc(r.symbol)}</small> · ציון ${r.score} ${deltaHtml(
        r.symbol,
        r.score,
        prevScores
      )}</summary>
        <ul>${r.signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        ${renderHistoricalEvidence(historicalForecasts?.get(r.symbol))}
      </details>`
    )
    .join("\n");

  const buyCount = buys.length;
  const holdCount = sorted.filter((r) => r.recommendation === "החזקה").length;
  const sellCount = sorted.filter(
    (r) => r.recommendation === "הימנעות / מכירה"
  ).length;
  const rankingColumns = ["#", "מניה", "סימול", "מחיר", "ציון", "Δ", ...(hasHz ? ["שבועי", "ארוך", "משולב", "פקטורים", "ציונים"] : []), "המלצה", "RSI", "Stoch", "ADX", "מגמה", "חדשות"];
  const numericColumns = new Set(["#", "מחיר", "ציון", "Δ", "שבועי", "משולב", "פקטורים", "RSI", "Stoch", "ADX"]);
  const health = summary.dataHealth;
  const barDates = [...new Set(Object.values(health?.latestBarDates ?? {}).filter((date): date is string => !!date && /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  const freshness = barDates.length ? `${barDates[0]}${barDates.length > 1 ? ` / ${barDates[barDates.length - 1]}` : ""}` : "לא מתועד";
  const partial = health && (health.analyzed < health.expected || health.missingSymbols.length > 0 || Object.keys(health.failures).length > 0);
  const coverage = health ? `${health.analyzed} מתוך ${health.expected} מניות נותחו` : `${results.length} מניות נותחו; היקף האיסוף אינו מתועד`;
  const analyzedHoldings = summary.portfolio.filter((holding) => holding.coverage === "analyzed").length;
  const flaggedHoldings = summary.portfolio.filter((holding) => holding.alerts.length);
  const dateLabel = generatedAt.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "medium", timeStyle: "short" });
  const pick = horizons?.size ? selectDailyPick(results, horizons, regime).main : null;
  const quoted = PORTFOLIO.map((h) => describeQuoteStamp(quoteStamps?.get(h.name), generatedAt)).filter((q) => q != null);
  const liveCount = quoted.filter((q) => q.today).length;
  const quoteNote = quoted.length
    ? `${liveCount ? `${liveCount} מתוך ${PORTFOLIO.length} החזקות עם ציטוט תוך-יומי מהיום` : "כל מחירי התיק מסשקות קודמים (לפני פתיחת המסחר או יום ללא מסחר)"}. זמן הציטוט מוצג ליד כל מחיר; מחירי תוך-יום עשויים להיות בעיכוב עד 20 דקות.`
    : "זמן ההפקה אינו זמן הציטוט; המחירים אינם נתוני זמן אמת.";

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)} — ${esc(generatedAt.toLocaleDateString("he-IL"))}</title>
${FONT_LINK}
<style>${REPORT_CSS}\n${BRIEF_CSS}</style>
</head>
<body>
<main class="report">
  <header class="report-header">
    <div class="report-identity"><span class="wordmark" dir="ltr">TASE / ANALYST</span>
    <span class="tag ${mode === "daily" ? "tag-daily" : "tag-weekly"}">${
    mode === "daily" ? "יומי" : "שבועי"
  }</span></div>
    <h1>${esc(title)}</h1>
    <div class="report-stamps"><p class="generated">הופק <time datetime="${esc(generatedAt.toISOString())}">${esc(dateLabel)}</time> · שעון ישראל</p>
    <p id="data-freshness">נרות יומיים אחרונים: ${esc(freshness)}</p></div>
    <p class="freshness-note ${liveCount ? "live" : ""}">${esc(quoteNote)}</p>
  </header>

  ${renderPortfolioBrief(input, summary)}

  <nav class="section-nav" aria-label="ניווט בדוח">
    <a href="#summary">תקציר</a><a href="#alerts">התראות</a><a href="#portfolio">התיק שלי</a>${input.fundViews?.length ? `<a href="#funds">קרנות לפי מדד</a>` : ""}<a href="#core">ליבה</a>${input.horizons?.size ? `<a href="#markets">ת"א / ארה"ב</a>` : ""}<a href="#rankings">דירוג מניות</a>${input.creator ? `<a href="#creator">${esc(input.creator.channels[0] ?? "ערוצים")}</a>` : ""}<a href="#evidence">ראיות</a><a href="#data-health">נתונים</a>
  </nav>

  <section id="summary" class="executive" aria-labelledby="summary-title">
    <div class="section-heading"><h2 id="summary-title">תמונת מצב</h2><a class="health-status ${partial || !results.length ? "warn" : ""}" href="#data-health">${!results.length ? "אין תוצאות ניתוח" : partial ? "איסוף חלקי" : health ? "נתוני איסוף" : "כיסוי לא מתועד"}</a></div>
    ${renderMarketStrip(indices, sparkCloses)}
    <h3 class="board-title">מה עושים עם כל החזקה</h3>
    ${renderActionBoard(input)}
    <div id="report-summary-text">
      <p><strong>${esc(coverage)}.</strong> כיסוי טכני ל־${analyzedHoldings} מתוך ${summary.portfolio.length} החזקות בתיק.</p>
      <p class="${flaggedHoldings.length ? "summary-alert" : "note"}">${flaggedHoldings.length
        ? `<strong>${flaggedHoldings.length} החזקות עם דגלי סיכון לבדיקה:</strong> ${flaggedHoldings.slice(0, 3).map((holding) => `${esc(holding.name)}: ${esc(holding.alerts[0])}`).join("; ")}${flaggedHoldings.length > 3 ? "; יתר הדגלים בסיכום המלא." : "."}`
        : "לא זוהו דגלי סיכון שמרניים בנתונים הזמינים; אין בכך אישור להיעדר סיכון."}</p>
      <p>${pick ? `מועמדת מובילה: <strong>${esc(pick.r.name)}</strong> · ציון משולב ${pick.hz.combined}. ` : ""}${esc(forecast.summary)}</p>
    </div>
    <div class="stats" aria-label="ספירת המלצות">
      <div class="stat stat-buy"><strong>${buyCount}</strong><span>קנייה</span></div>
      <div class="stat stat-hold"><strong>${holdCount}</strong><span>החזקה</span></div>
      <div class="stat stat-sell"><strong>${sellCount}</strong><span>מכירה / הימנעות</span></div>
      <div class="stat stat-total"><strong>${sorted.length}</strong><span>סה"כ נותחו</span></div>
    </div>
  </section>

  ${sellHtml}

  ${portfolioHtml}

  ${renderFundIndexSection(input.fundViews)}

  ${renderCoreSection(results, horizons)}

  ${pickHtml}

  ${renderMarketRecsSection(input)}

  ${regimeHtml}
  ${renderMacroSection(input.macro)}
  ${renderCreatorSection(input.creator)}

  <div class="disclaimer">
    הדוח מבוסס על ניתוח טכני אוטומטי ואינו מהווה ייעוץ השקעות. השקעה בניירות ערך כרוכה
    בסיכון. יש להתייעץ עם יועץ מורשה לפני קבלת החלטות.
  </div>
  ${forecastHtml}
  ${indicesHtml}

  <section id="rankings">
    <h2>טבלת המלצות מלאה</h2>
    <div class="ranking-toolbar"><label for="ranking-search">חיפוש מניה או סימול</label><input id="ranking-search" type="search" autocomplete="off" aria-controls="ranking-table" /><output id="ranking-count" aria-live="polite">${sorted.length} מניות</output></div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="טבלת המלצות מלאה">
      <table id="ranking-table">
        <caption>סדר ברירת מחדל: ${hybridActive ? "ציון פקטורים (מנוע היברידי)" : hasHz ? "ציון משולב" : "ציון טכני"}</caption>
        <thead><tr>
          ${rankingColumns.map((label, column) => `<th scope="col" aria-sort="none"><button type="button" class="sort-button" data-column="${column}" data-numeric="${numericColumns.has(label)}" aria-label="מיון לפי ${esc(label)}">${esc(label)} <span aria-hidden="true">↕</span></button></th>`).join("")}
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <p id="ranking-empty" class="empty" hidden>אין מניות תואמות לחיפוש.</p>
    <p class="note">${esc(describeEngine(input.engine))}</p>
    <p class="note">עמודת "ציונים" בסדר: מומנטום · רוויזיות · הפתעות · איכות · שווי · סיכון · קונצנזוס · ביקוש (A הטוב ביותר, — = אין מספיק נתונים, 🚩 = דגל אדום). איכות ושווי מושווים מול הסקטור כשיש בו 5 ניירות לפחות (Seeking Alpha); קונצנזוס = אנליסטים, יעדים, שינויי המלצות ומקורבים (TipRanks); ביקוש = מחזור בימי עלייה מול ימי ירידה (IBD). ${esc(describeGradeValidation(input.gradeValidation, GRADES_IN_RANKING))}</p>
  </section>

  <section class="buy-section">
    <h2>מומלצות לרכישה</h2>
    <details id="buy-catalog"><summary>כל המועמדות לרכישה <span class="catalog-count">${buyCount}</span></summary><div class="cards">${buyCards}</div></details>
  </section>

  ${renderPortfolioEvidence(historicalForecasts)}
  ${scorecardHtml}
  ${corrHtml}
  ${renderExposureSection(input.exposure)}

  <section>
    <h2>פירוט מלא לכל המניות</h2>
    <div class="details">${detailRows}</div>
  </section>

  <section id="data-health" aria-labelledby="data-health-title">
    <h2 id="data-health-title">בריאות הנתונים וסיכום הדוח</h2>
    <p class="note">${esc(coverage)}. תאריכי הנרות: ${esc(freshness)}. תאריך קודם עשוי לשקף יום מנוחה או חג.</p>
    <details id="health-details"><summary>פרטי איסוף ותאריכי נרות</summary><ul class="health-list">${summary.health.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></details>
    <details id="full-summary"><summary>סיכום הדוח בעברית</summary><div class="full-summary-text">${summary.summary.split("\n").filter(Boolean).map((line) => `<p>${esc(line)}</p>`).join("")}</div></details>
  </section>

  <footer class="report-foot">© ${generatedAt.getFullYear()} TASE Analyst Agent</footer>
</main>
<script type="application/json" id="report-summary">${summaryJson}</script>
<script>${REPORT_SCRIPT}</script>
<script src="../report-view.js" defer></script>
</body>
</html>`;
}

export interface IndexReportEntry {
  mode: Mode;
  date: string; // YYYY-MM-DD
  file: string; // file name
}

const REPOSITORY_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** בונה את עמוד index.html עם סרגל צד וניווט יומי/שבועי. */
export function buildIndexHtml(entries: IndexReportEntry[]): string {
  const data = JSON.stringify(entries).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const workflowUrl = REPOSITORY_PATH.test(repository) ? `https://github.com/${repository}/actions/workflows/reports.yml` : "";
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#23734e" />
<title>דוחות ניתוח טכני — בורסת ת"א</title>
${FONT_LINK}
<link rel="manifest" href="./manifest.webmanifest" />
<style>${INDEX_CSS}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand">
    <div>
      <span class="brand-market" dir="ltr">TASE / ANALYST</span>
      <h1>דוחות שוק ההון</h1>
    </div>
  </div>

  <div class="toggle" role="tablist" aria-label="סוג דוח">
    <button id="btn-daily" role="tab" aria-selected="true" aria-controls="report-list" class="active" onclick="setMode('daily')">יומי</button>
    <button id="btn-weekly" role="tab" aria-selected="false" aria-controls="report-list" tabindex="-1" onclick="setMode('weekly')">שבועי</button>
  </div>

  <div class="run-box">
    <a id="manage-reports" class="manage-link" ${workflowUrl ? `href="${esc(workflowUrl)}"` : "hidden"} target="_blank" rel="noopener noreferrer">ניהול והפקת דוח <span aria-hidden="true">↗</span></a>
    <button id="run-daily" class="run-btn run-daily" hidden onclick="runReport('daily')">הפקת דוח יומי</button>
    <button id="run-weekly" class="run-btn run-weekly" hidden onclick="runReport('weekly')">הפקת דוח שבועי</button>
    <div id="run-status" class="run-status" role="status" aria-live="polite"></div>
    <div class="app-actions">
      <button id="install-app" class="app-btn install-btn" type="button" hidden>התקנת האפליקציה</button>
      <button id="open-app-help" class="app-btn help-btn" type="button">מדריך התקנה וניהול</button>
    </div>
    <div id="app-status" class="app-status" role="status" aria-live="polite">להתקנה ב-Chrome ב-Android פתחו את המדריך. ההתקנה תלויה בחיבור מאובטח ובהודעת הדפדפן.</div>
  </div>

  <h2 class="archive-heading">ארכיון דוחות</h2>
  <nav id="report-list" class="report-list" role="tabpanel" aria-labelledby="btn-daily" tabindex="0"></nav>
  <footer class="side-foot">© ${new Date().getFullYear()} TASE Analyst Agent</footer>
</aside>

<main class="viewer">
  <header class="viewer-header"><p id="current-report" aria-live="polite">אין דוח נבחר</p><a id="open-report" hidden target="_blank" rel="noopener noreferrer">פתיחת הדוח <span aria-hidden="true">↗</span></a></header>
  <div id="empty-state" class="empty-state">
    <p>אין דוחות זמינים</p>
  </div>
  <iframe id="frame" title="דוח" style="display:none"></iframe>
</main>

<dialog id="app-help" class="app-dialog" aria-labelledby="app-help-title">
  <div class="app-dialog-shell">
    <header class="app-dialog-head">
      <div>
        <p class="app-dialog-kicker">PWA ל-Android</p>
        <h2 id="app-help-title">מדריך התקנה וניהול מתוך האתר</h2>
      </div>
      <button id="close-app-help" class="app-btn close-btn" type="button">סגירה</button>
    </header>
    <div class="app-dialog-body">
      <section class="help-section">
        <h3>התקנה והפעלה ראשונה</h3>
        <p>ב-Chrome ב-Android פתחו את האתר דרך כתובת HTTPS, לחצו על כפתור ההתקנה אם הדפדפן מציע אותו, או פתחו את תפריט Chrome ובחרו "הוספה למסך הבית" או "התקנת אפליקציה". לאחר ההתקנה האפליקציה נפתחת בחלון עצמאי, אך עדיין קוראת את הדוחות מהרשת ואינה שומרת עותק לא מקוון של דוח ישן.</p>
        <p>ב-GitHub היכנסו לחשבון עם הרשאת כתיבה למאגר ובחרו Actions > Manage & Build Reports > Run workflow, בענף main. מומלץ תחילה action=list כדי לבדוק את התצורה, אחריו action=report עם mode=daily, weekly או both. אפשר להמשיך להשתמש באתר גם בלי התקנה.</p>
        <p><a id="help-management" class="help-management" hidden target="_blank" rel="noopener noreferrer">פתיחת טופס הניהול ב-GitHub <span aria-hidden="true">↗</span></a></p>
      </section>

      <section class="help-section">
        <h3>עשרת שדות הטופס</h3>
        <div class="help-fields">
          <article><h4>action</h4><p>report להפקה, list להצגת התצורה, add להוספה, update לעדכון, remove להסרה.</p></article>
          <article><h4>mode</h4><p>daily, weekly או both עבור report. ב-list אין הפקה חדשה. add, update ו-remove מפיקים דוח יומי אוטומטית.</p></article>
          <article><h4>target</h4><p>portfolio להחזקות או watchlist לרשימת מעקב. list מציג את הכול.</p></article>
          <article><h4>identifier</h4><p>סימול Yahoo שבדקתם כמו DSCT.TA או HPQ, או מספר ת"א בן 5-10 ספרות להחזקת מחיר בלבד. אימות הפורמט אינו אימות אוטומטי של הבורסה או המטבע.</p></article>
          <article><h4>name</h4><p>חובה ב-add. ב-update שדה ריק פירושו ללא שינוי, ולא מנקים את השם עם '-'.</p></article>
          <article><h4>entry_price</h4><p>חובה בהוספת portfolio. ת"א באגורות ולא בשקלים, ונכסים אמריקאיים ב-USD בלבד. שדה ריק שומר ערך קיים ו-'-' אינו חוקי כאן.</p></article>
          <article><h4>sector</h4><p>שדה אופציונלי לתיק או למעקב. שדה ריק משאיר ערך קיים, ו-'-' מנקה שדה אופציונלי.</p></article>
          <article><h4>investing_url</h4><p>בתיק בלבד: קישור Investing תקין ל-etfs או equities, בלי query או fragment. נדרש למספר ת"א ללא סימול Yahoo.</p></article>
          <article><h4>alert_below</h4><p>בתיק בלבד: מחיר התראה חיובי באותן יחידות כמו entry_price. שדה ריק שומר, ו-'-' מנקה בעדכון.</p></article>
          <article><h4>trigger_index</h4><p>בתיק בלבד: מדד נתמך כמו ^NDX או TA35.TA. שדה ריק שומר, ו-'-' מנקה בעדכון תקין.</p></article>
        </div>
      </section>

      <section class="help-section help-grid">
        <article>
          <h3>ניהול רשומות</h3>
          <p>add אינו upsert ודוחה רשומה קיימת. update ו-remove דורשים רשומה שכבר קיימת. בהסרה ממלאים רק target ו-identifier ומשאירים את שדות התוכן ריקים. הסרה מהתיק אינה הוראת מכירה, והסרה מהתיק גם אינה מסירה אוטומטית מה-watchlist.</p>
          <p>לדוגמה, הוספה למעקב: action=add, target=watchlist, identifier=MSFT, name=Microsoft. הוספה לתיק: target=portfolio ובנוסף entry_price עם מחיר הקנייה שלכם. בדקו ב-list שאין כבר רשומה.</p>
          <p>עדכון הקרן הקיימת: action=update, target=portfolio, identifier=1145903, entry_price=4502. אלה 4,502 אגורות, כלומר 45.02 ש"ח ליחידה. אין צורך להוסיף אותה שוב.</p>
        </article>
        <article>
          <h3>תיק מול מעקב</h3>
          <p>portfolio מיועד להחזקות עם entry_price, alert_below ו-trigger_index לפי הצורך. watchlist מיועד למעקב בלבד. החזקת Yahoo מצטרפת גם למעקב, ולכן אי אפשר להסיר אותה מה-watchlist כל עוד היא עדיין מוחזקת בתיק.</p>
        </article>
        <article>
          <h3>מזהים ויחידות</h3>
          <p>נתמכות מניות ת"א עם ‎.TA ומניות או ETF אמריקאיים עם סימול לטיני פשוט. אין תמיכה כללית במדדים שמתחילים ב-^ כמזהי החזקה, במט"ח עם = או בבורסות אחרות. מספר ת"א תקף אינו מבטיח ציון טכני מלא אלא רק מסלול מחיר בלבד כשאין היסטוריית Yahoo.</p>
        </article>
        <article>
          <h3>תזמון ותוצרים</h3>
          <p>היומי רץ ב-21:37 UTC בימי שני עד שישי, והשבועי ב-21:47 UTC ביום שישי. ההמרה לשעון ישראל משתנה עם שעון קיץ וחורף. בתוצרי Actions אפשר להוריד latest-daily.txt, latest-weekly.txt, דוחות HTML ו-run-status.txt מתוך ה-artifact.</p>
        </article>
        <article>
          <h3>מסלול עבודה ותקלות</h3>
          <p>המסלול הרגיל הוא list לבדיקת מצב, אחריו add, update או remove לפי הצורך. השינוי שומר את התצורה ומנסה להפיק דוח יומי; כשל באיסוף אינו מבטל את שינוי התצורה. אין צורך בהרצת report נוספת מיד אחריו. בודקים את סטטוס ההרצה ותאריכי הנתונים.</p>
          <p>אם Manage & Build Reports אינו מופיע, ודאו שהקובץ נמצא בנתיב .github/workflows/reports.yml בענף main, ולא בתור reports.yml בשורש המאגר. לפרסום אוטומטי ב-Pages דרושים Source: GitHub Actions והמשתנה PUBLISH_PAGES=true. GitHub עשוי לעכב הפקות מתוזמנות.</p>
          <p>בסיום הרצה פותחים את Summary ב-Actions לסיכום, או מורידים את חבילת ה-Artifacts ומחלצים את כולה. את index.html פותחים לצד תיקיית reports ושאר קובצי האתר. מחירים אינם נתוני זמן אמת.</p>
        </article>
        <article>
          <h3>פרטיות ומגבלות</h3>
          <p>האתר וההתקנה אינם הופכים מידע לציבורי או לפרטי יותר ממצב האירוח הקיים. אין להזין סודות, מפתחות API או פרטי כניסה בטופס. הדוחות והתקצירים אינם ייעוץ השקעות, והמערכת אינה מבצעת קנייה או מכירה בפועל.</p>
        </article>
      </section>
    </div>
  </div>
</dialog>

<script>
const REPORTS = ${data};
const CONFIGURED_WORKFLOW = ${JSON.stringify(workflowUrl)};
const repositoryPattern = new RegExp(${JSON.stringify(REPOSITORY_PATH.source)});
const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) && ['http:', 'https:'].includes(location.protocol);
let currentMode = 'daily';

function managementUrl() {
  if (CONFIGURED_WORKFLOW) return CONFIGURED_WORKFLOW;
  const pages = /^([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\\.github\\.io$/i.exec(location.hostname);
  if (!pages) return '';
  const segment = location.pathname.split('/').filter(Boolean)[0];
  const repository = !segment || segment === 'index.html' ? pages[1] + '.github.io' : segment;
  const path = pages[1] + '/' + repository;
  return repositoryPattern.test(path) ? 'https://github.com/' + path + '/actions/workflows/reports.yml' : '';
}

const manager = document.getElementById('manage-reports');
const workflow = managementUrl();
manager.hidden = !workflow;
if (workflow) manager.href = workflow;
document.querySelectorAll('.run-btn').forEach(button => { button.hidden = !isLocal; });
if (!isLocal && !workflow) document.getElementById('run-status').textContent = 'קישור הניהול אינו זמין: לא הוגדר מאגר.';

function fmtDate(d) {
  const [y, m, day] = d.split('-');
  return day + '.' + m + '.' + y;
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById('btn-daily').classList.toggle('active', mode === 'daily');
  document.getElementById('btn-weekly').classList.toggle('active', mode === 'weekly');
  for (const value of ['daily', 'weekly']) {
    const button = document.getElementById('btn-' + value);
    button.setAttribute('aria-selected', String(value === mode));
    button.tabIndex = value === mode ? 0 : -1;
  }
  document.getElementById('report-list').setAttribute('aria-labelledby', 'btn-' + mode);
  renderList();
}

document.querySelector('.toggle').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const mode = event.key === 'Home' ? 'daily' : event.key === 'End' ? 'weekly' : currentMode === 'daily' ? 'weekly' : 'daily';
  setMode(mode);
  document.getElementById('btn-' + mode).focus();
});

function renderList() {
  const list = document.getElementById('report-list');
  const items = REPORTS.filter(r => r.mode === currentMode)
    .sort((a, b) => b.date.localeCompare(a.date));
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<p class="no-reports">אין דוחות זמינים</p>';
    const frame = document.getElementById('frame');
    frame.removeAttribute('src');
    frame.style.display = 'none';
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('current-report').textContent = 'אין דוח ' + (currentMode === 'daily' ? 'יומי' : 'שבועי') + ' זמין';
    document.getElementById('open-report').hidden = true;
    document.getElementById('open-report').removeAttribute('href');
    return;
  }
  items.forEach((r, i) => {
    const a = document.createElement('button');
    a.className = 'report-item';
    const date = document.createElement('span');
    date.className = 'd';
    date.textContent = fmtDate(r.date);
    a.appendChild(date);
    if (i === 0) {
      const latest = document.createElement('span');
      latest.className = 'latest';
      latest.textContent = 'אחרון';
      a.appendChild(latest);
    }
    a.onclick = () => openReport(r.file, a);
    list.appendChild(a);
  });
  // טען אוטומטית את הדוח האחרון
  openReport(items[0].file, list.firstChild);
}

function openReport(file, el) {
  if (!/^(?:reports\\/)?report-(?:daily|weekly)-\\d{4}-\\d{2}-\\d{2}\\.html$/.test(file)) return;
  document.querySelectorAll('.report-item').forEach(node => {
    node.classList.remove('selected');
    node.removeAttribute('aria-current');
  });
  if (el) {
    el.classList.add('selected');
    el.setAttribute('aria-current', 'page');
  }
  const frame = document.getElementById('frame');
  frame.src = file;
  frame.style.display = 'block';
  document.getElementById('empty-state').style.display = 'none';
  const report = REPORTS.find(entry => entry.file === file);
  const label = 'דוח ' + (report?.mode === 'weekly' ? 'שבועי' : 'יומי') + (report ? ' · ' + fmtDate(report.date) : '');
  document.getElementById('current-report').textContent = label;
  frame.title = label;
  const link = document.getElementById('open-report');
  link.href = file;
  link.hidden = false;
}

async function runReport(mode) {
  const status = document.getElementById('run-status');
  const btns = document.querySelectorAll('.run-btn');
  if (!['daily', 'weekly'].includes(mode)) return;
  if (!isLocal) {
    if (workflow) manager.focus();
    else status.textContent = 'קישור הניהול אינו זמין: לא הוגדר מאגר.';
    return;
  }
  btns.forEach(b => b.disabled = true);
  status.className = 'run-status busy';
  status.textContent = 'מפיק דוח ' + (mode === 'daily' ? 'יומי' : 'שבועי') + '...';
  try {
    const res = await fetch('/api/run?mode=' + mode, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'שגיאה בהפקת הדוח');
    status.className = 'run-status ok';
    status.textContent = 'הדוח הופק בהצלחה. טוען מחדש...';
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    status.className = 'run-status err';
    status.textContent = 'ההפקה נכשלה: ' + err.message;
    btns.forEach(b => b.disabled = false);
  }
}

renderList();
</script>
<script src="./app.js" defer></script>
<script src="./report-view.js" defer></script>
</body>
</html>`;
}

const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700&display=swap" />';

const REPORT_SCRIPT = `
const rankingTable = document.getElementById('ranking-table');
const rankingRows = Array.from(rankingTable.tBodies[0].rows);
const search = document.getElementById('ranking-search');
search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase('he');
  let count = 0;
  rankingRows.forEach(row => {
    row.hidden = ![row.cells[1].textContent, row.cells[2].textContent].join(' ').toLocaleLowerCase('he').includes(query);
    if (!row.hidden) count++;
  });
  document.getElementById('ranking-count').textContent = count + ' מניות';
  document.getElementById('ranking-empty').hidden = count !== 0;
});
rankingTable.querySelectorAll('.sort-button').forEach(button => {
  button.addEventListener('click', () => {
    const heading = button.closest('th');
    const ascending = heading.getAttribute('aria-sort') !== 'ascending';
    const column = Number(button.dataset.column);
    rankingTable.querySelectorAll('thead th').forEach(header => header.setAttribute('aria-sort', 'none'));
    heading.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
    const rows = [...rankingRows].sort((left, right) => {
      const leftText = left.cells[column].textContent.trim();
      const rightText = right.cells[column].textContent.trim();
      let difference;
      if (button.dataset.numeric === 'true') {
        const leftValue = /\\d/.test(leftText) ? Number(leftText.replace(/[^\\d.+-]/g, '')) : NaN;
        const rightValue = /\\d/.test(rightText) ? Number(rightText.replace(/[^\\d.+-]/g, '')) : NaN;
        if (!Number.isFinite(leftValue)) return Number.isFinite(rightValue) ? 1 : 0;
        if (!Number.isFinite(rightValue)) return -1;
        difference = leftValue - rightValue;
      } else difference = leftText.localeCompare(rightText, 'he');
      return ascending ? difference : -difference;
    });
    rows.forEach(row => rankingTable.tBodies[0].appendChild(row));
  });
});
document.querySelectorAll('.table-wrap').forEach(region => {
  region.tabIndex = 0;
  region.setAttribute('role', 'region');
  if (!region.hasAttribute('aria-label')) region.setAttribute('aria-label', region.closest('section')?.querySelector('h2')?.textContent || 'טבלת נתונים');
});
const printDetails = [];
addEventListener('beforeprint', () => {
  document.querySelectorAll('details').forEach(detail => {
    if (!detail.open) { printDetails.push(detail); detail.open = true; }
  });
});
addEventListener('afterprint', () => { printDetails.splice(0).forEach(detail => detail.open = false); });
`;

const WORKSPACE_CSS = `
:root{--bg:#f0f2f4;--card:#fff;--ink:#24272c;--muted:#626870;--line:#d9dde2;
--buy:#23734e;--strongbuy:#155537;--hold:#895a13;--sell:#b33440;--accent:#343a42;--soft:#f4f5f7;
--positive:#eaf4ee;--negative:#fcf0f1;--caution:#fcf6e8}
*{box-sizing:border-box}
html{color-scheme:light}
body{margin:0;font:14px/1.6 "Heebo","Noto Sans Hebrew","Tahoma",sans-serif;letter-spacing:0;background:var(--bg);color:var(--ink)}
button,input,select{font:inherit;letter-spacing:0}
*,*::before,*::after{letter-spacing:0}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
a{color:var(--accent);text-underline-offset:3px}
button{touch-action:manipulation}
[hidden]{display:none!important}
bdi,.num,.score,.delta,.idx-price,.idx-score,.pl,.metrics strong,.risk-box strong,.regime-metrics strong,.d{font-variant-numeric:tabular-nums}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

const REPORT_CSS = `
${WORKSPACE_CSS}
.report{max-width:1440px;margin:0 auto;padding:20px 32px;min-width:0;background:var(--card);border-top:4px solid var(--ink)}
.report>section{min-width:0;margin-block:24px;padding-bottom:24px;border-bottom:1px solid var(--line);scroll-margin-block-start:16px}
.report-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 24px;padding-block:4px 16px;border-bottom:2px solid var(--ink)}
.report-identity{grid-column:1/-1;display:flex;align-items:center;gap:12px}.wordmark{font-size:12px;font-weight:700;color:var(--muted)}
.tag{display:inline-block;padding:2px 8px;background:var(--ink);color:#fff;border-radius:3px;font-size:12px;font-weight:600}
.report-header h1{margin:0;font-size:24px;line-height:1.45;align-self:center;overflow-wrap:anywhere}
.report-stamps{font-size:12px;text-align:end;color:var(--muted)}.report-stamps p{margin:0}.report-stamps time{color:var(--ink);font-weight:600}
.freshness-note{grid-column:1/-1;font-size:12px;color:var(--muted);margin:0}
.section-nav{display:flex;flex-wrap:wrap;gap:4px 20px;border-bottom:1px solid var(--line);padding-block:4px}
.section-nav a{display:flex;align-items:center;min-height:40px;text-decoration:none;font-size:13px;font-weight:600;border-bottom:2px solid transparent}.section-nav a:hover{border-color:var(--ink)}
h2{font-size:19px;line-height:1.45;margin:0 0 14px;font-weight:700;overflow-wrap:anywhere}h3,h4,h5{overflow-wrap:anywhere}
.section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}.section-heading h2{margin:0}
.health-status{font-size:12px;color:var(--muted)}.health-status.warn{color:var(--hold);font-weight:600}
#report-summary-text{display:grid;grid-template-columns:1fr 1.5fr 1fr;gap:24px;font-size:13px}
#report-summary-text p{margin:0;overflow-wrap:anywhere}.summary-alert{border-inline-start:2px solid var(--hold);padding-inline-start:12px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin-top:18px}
.stat{display:flex;align-items:baseline;gap:12px;padding-top:8px;border-top:2px solid var(--line);min-width:0}
.stat strong{font-size:28px;line-height:1.3;font-weight:600;font-variant-numeric:tabular-nums}.stat span{font-size:12px;color:var(--muted)}
.stat-buy{border-color:var(--buy)}.stat-buy strong{color:var(--buy)}.stat-hold{border-color:var(--hold)}.stat-hold strong{color:var(--hold)}
.stat-sell{border-color:var(--sell)}.stat-sell strong{color:var(--sell)}.stat-total{border-color:var(--ink)}
.disclaimer{background:var(--caution);border-inline-start:3px solid var(--hold);color:var(--hold);padding:10px 14px;font-size:12px;margin-block:20px}
.fc-intro{font-size:14px;margin:0 0 16px}.fc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.fc-head h3{margin:0;font-size:17px}.fc-block{margin-top:12px}.fc-block h4{margin:0 0 6px;font-size:14px}.fc-block ul{margin:0;padding-inline-start:18px;font-size:13px}
.fc-horizon{margin:0 0 12px;font-size:12px;color:var(--muted)}.fc-note{margin:16px 0 0;font-size:12px;color:var(--muted)}
.fc-tone{display:inline-block;margin-inline-start:6px;color:var(--muted);font-size:12px;font-weight:600}
.cards,.fc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}
.card,.fc-card,.idx-card,.sell-card{border:1px solid var(--line);border-radius:6px;padding:16px;background:var(--card);min-width:0}
.card-head,.pick-head,.sell-card header,.regime-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.card-head h3,.pick-head h3,.sell-card h3{margin:0;flex:1 1 160px;font-size:17px;overflow-wrap:anywhere}
.card-head small,.pick-head small,.sell-card small,.idx-head small{display:inline-block;direction:ltr;unicode-bidi:isolate;color:var(--muted);font-size:12px;font-weight:400}
.card-score{font-weight:700}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:14px 0}
.metrics div{border-bottom:1px solid var(--line);padding:8px 4px;min-width:0;text-align:center}.metrics span{display:block;color:var(--muted);font-size:11px}
.metrics strong{font-size:14px;overflow-wrap:anywhere}
.signals,.detail ul,.idx-signals{margin:8px 0 0;padding-inline-start:18px;font-size:13px}.signals li,.idx-signals li{margin-block:3px}
.news{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:13px}.news-title{font-weight:600}.news ul{margin:6px 0 0;padding-inline-start:18px}.news em{color:var(--muted);font-style:normal;font-size:12px}
.signals,.news,.fc-block,.idx-signals,.historical-evidence{overflow-wrap:anywhere}
.badge,.pick-label,.sell-level{display:inline-block;border-radius:3px;padding:3px 8px;font-size:12px;font-weight:600;white-space:nowrap}
.rec-strong-buy{background:var(--strongbuy);color:#fff}.rec-buy{background:var(--positive);color:var(--buy)}.rec-hold{background:var(--caution);color:var(--hold)}.rec-sell{background:var(--negative);color:var(--sell)}
.pick-label{color:#fff}.sell-level{background:var(--sell);color:#fff}
.table-wrap{max-width:100%;max-height:70vh;overflow:auto;overscroll-behavior-inline:contain;border-block:1px solid var(--line);scrollbar-gutter:stable}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:680px}
caption{text-align:right;padding:9px 12px;font-size:12px;color:var(--muted);background:var(--card)}
thead th{position:sticky;top:0;padding:10px;text-align:right;border-bottom:1px solid var(--line);background:var(--soft);color:var(--muted);z-index:2;vertical-align:bottom;white-space:nowrap}
tbody th{padding:10px;text-align:right;border-bottom:1px solid var(--line);font-weight:500}
tbody td{padding:12px 10px;vertical-align:top;border-bottom:1px solid var(--line)}
tbody tr:nth-child(even){background:#fafbfc}tbody tr:hover{background:#edf0f3}
.num{text-align:left;direction:ltr;unicode-bidi:isolate;white-space:nowrap;min-width:76px;width:92px}.center{text-align:center}
.sym{direction:ltr;unicode-bidi:isolate;white-space:nowrap;min-width:96px;font-size:12px;color:var(--muted)}
.rank{width:40px;min-width:40px;color:var(--muted)}.name{min-width:140px;font-weight:600}
.score{display:inline-block;width:40px;text-align:center;font-weight:700}.delta{display:inline-block;min-width:40px;margin-inline-start:4px;font-size:12px;font-weight:600}
.up,.delta.up,.pl.up,.lt.pos,.pf-trigger.ok{color:var(--buy)}.down,.delta.down,.pl.down,.lt.neg{color:var(--sell)}
.delta.flat,.delta.na,.pl.na,.lt.neu,.lt.na,.pf-trigger.na{color:var(--muted)}
.portfolio .name small{display:block;color:var(--muted);font-weight:400;font-size:12px}.pl{font-weight:600}
.pf-score{font-size:12px;color:var(--muted);white-space:nowrap}.pf-trigger,.lt{font-size:12px;font-weight:600}.pf-trigger.warn{color:var(--hold)}
.pf-hz,.pf-risk{font-size:12px;margin-top:4px}.pf-hz{color:var(--muted)}.pf-alert{margin-top:4px;font-size:12px;font-weight:600;color:var(--sell)}
.core-tag{display:inline-block;font-size:11px;font-weight:600;padding:0 6px;border-radius:999px;background:#e5efe9;color:#146848}
.core-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.core-card{border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0;overflow-wrap:anywhere}
.core-card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}.core-card h3{margin:0;font-size:16px}.core-card h3 small{color:var(--muted);font-weight:400}
.core-card ul{margin:10px 0 0;padding-inline-start:18px;font-size:13px;line-height:1.8}.core-zone{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px}
.zone-good{background:#e5efe9;color:#146848}.zone-fair{background:#eef2f6;color:#265e87}.zone-stretched{background:#f8ece6;color:#ac303e}.stars{color:#ad781c;letter-spacing:1px}
.grades{font-size:12px;margin-top:4px;font-weight:600}.grades-why{font-size:12px;color:var(--muted)}.grades-flag{font-size:12px;font-weight:600;color:var(--sell)}
.coverage-note{font-size:12px;color:var(--hold);margin-top:4px;max-width:440px}.pf-delta{margin-top:4px;font-size:12px}
.pf-delta ul{margin:4px 0;padding-inline-start:18px}.pf-delta .add{color:var(--buy)}.pf-delta .rem{color:var(--muted)}
.spark-cell{width:140px}.spark{display:block;width:120px;height:32px;margin-top:4px;overflow:visible}
.spark polyline{fill:none;stroke-width:1.7}.spark.up polyline{stroke:var(--buy)}.spark.down polyline{stroke:var(--sell)}.spark-stop{stroke:var(--hold);stroke-width:1;stroke-dasharray:3 3}
.portfolio table{min-width:860px}.portfolio td:last-child{min-width:290px}
.idx-intro{color:var(--muted);font-size:13px;margin:0 0 16px}.idx-region{margin-bottom:24px}
.idx-cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.idx-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap}.idx-head h4{flex:1 1 160px;margin:0;font-size:16px}
.idx-region h3{font-size:15px;margin:0 0 12px;color:var(--muted)}.idx-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:12px 0}
.idx-price{font-size:23px;font-weight:600}.idx-chg{font-size:13px;font-weight:600}.idx-score{margin-inline-start:auto;font-size:12px;color:var(--muted)}
.idx-rec{font-size:13px;margin-bottom:8px}.idx-metrics{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}.idx-metrics span{font-size:12px;color:var(--muted)}
.idx-metrics span{border-inline-end:1px solid var(--line);padding-inline-end:8px}
.pick-main{border-inline-start:3px solid var(--buy);padding:4px 16px}
.pick-label{background:var(--accent)}.pick-combined,.regime-score,.pick-regime{color:var(--accent)}
.pick-combined,.regime-score{font-size:17px;font-weight:700}.pick-breakdown{font-size:13px;margin:10px 0 4px}.pick-overlap{font-size:13px;color:var(--hold);margin-top:6px}
.pick-rs,.pick-regime{font-size:13px;margin:6px 0}.pick-alts,.pick-rejected{margin-top:14px}
.market-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:18px}.market-recs{border-top:3px solid var(--line);padding-top:10px;min-width:0}.market-recs h3{margin:0 0 4px}.market-recs h4{margin:12px 0 6px;font-size:14px}.market-recs .signals li{overflow-wrap:anywhere}
.pick-strength,.sell-watchlist{margin-top:14px;border-top:1px solid var(--line);padding:12px 0;font-size:13px}
.sell-watchlist h4,.pick-alts h4{margin:0 0 8px;font-size:14px}.sell-watchlist ul,.pick-alts ul,.pick-rejected ul{margin:0;padding-inline-start:18px;font-size:13px}.sell-watchlist li,.pick-alts li{margin-block:6px}
.risk-box,.regime-metrics,.score-summary,.beta-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:16px;margin:14px 0}
.risk-box div,.regime-metrics div,.score-summary div,.beta-list div{display:flex;flex-direction:column;gap:2px;border-bottom:1px solid var(--line);padding-block:8px;min-width:0}
.risk-box span,.regime-metrics span,.score-summary span,.beta-list span{font-size:12px;color:var(--muted)}.risk-box strong,.regime-metrics strong,.score-summary strong,.beta-list strong{font-size:18px;font-weight:600}
.risk-box small,.beta-list small{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.regime-bench{font-size:13px;color:var(--muted)}
.corr-high td{background:var(--negative)}.corr-mid td{background:var(--caution)}
.sell>h2{color:var(--sell)}.sell-card{border-inline-start:3px solid var(--sell);margin-bottom:12px}.sell-price{font-size:13px;font-weight:600}.sell-stop{font-size:13px;margin:8px 0 0}
.sell-card.sell-reduce,.sell-card.sell-watch{border-inline-start-color:var(--hold)}
.sell-card.sell-reduce .sell-level,.sell-card.sell-watch .sell-level{background:var(--hold)}
.detail,.evidence-holding{border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:4px 0;min-width:0}
.note,.empty{font-size:13px;color:var(--muted);margin:8px 0 12px}.empty{padding-block:8px}
summary{cursor:pointer;line-height:1.6;padding-block:10px;overflow-wrap:anywhere;font-size:13px;font-weight:500}
summary::marker{color:var(--muted)}details{min-width:0}details[open]>summary{margin-bottom:8px}.detail summary{font-weight:600}.detail ul{margin-bottom:12px}
.catalog-count{display:inline-block;min-width:32px;text-align:center;color:var(--muted);font-variant-numeric:tabular-nums}
.health-list{columns:2;column-gap:32px;max-height:400px;overflow:auto;padding-inline-start:18px;font-size:12px;overflow-wrap:anywhere}.health-list li{break-inside:avoid;margin-bottom:6px}
.full-summary-text{max-height:560px;overflow:auto;font-size:13px;overflow-wrap:anywhere}
.historical-evidence{min-width:0;padding-block:8px}.historical-evidence h5{font-size:13px;margin:12px 0 4px}
.historical-evidence .note{font-size:12px;margin:6px 0 12px}
.evidence-meta{font-size:13px;color:var(--muted);margin:0 0 6px}
.evidence-table{min-width:1050px}.evidence-table .num{min-width:100px}
.evidence-table th:first-child{min-width:120px}.abstention{color:var(--hold)}
.evidence-warnings{color:var(--hold);font-size:13px}.evidence-dates{font-size:12px}
.evidence-dates ul{max-height:200px;overflow:auto}.index-evidence{border-top:1px solid var(--line);margin-top:12px;font-size:13px}
.ranking-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;font-size:13px}
.ranking-toolbar input{width:260px;max-width:100%;min-height:40px;padding:6px 10px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:4px}
.ranking-toolbar output{color:var(--muted);font-variant-numeric:tabular-nums;min-width:80px}
.sort-button{background:transparent;border:0;color:inherit;font-weight:600;cursor:pointer;padding:8px 0;min-height:40px;white-space:nowrap}
.sort-button span{display:inline-block;width:12px;color:var(--muted)}
th[aria-sort="ascending"] .sort-button span,th[aria-sort="descending"] .sort-button span{color:var(--accent)}
.fc-head{flex-wrap:wrap}.report-foot{color:var(--muted);font-size:12px;text-align:center;padding:16px 0}
.freshness-note.live{color:var(--buy);font-weight:600}
.quote-chip{display:inline-block;align-self:flex-start;margin-top:4px;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;direction:rtl}
.quote-chip.live{background:var(--positive);color:var(--buy)}.quote-chip.stale{background:var(--caution);color:var(--hold)}.quote-chip.unknown{background:var(--soft);color:var(--muted)}
.mkt-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:4px 0 18px}
.mkt-chip{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-top:3px solid var(--line);border-radius:6px;min-width:0}
.mkt-chip.good{border-top-color:var(--buy)}.mkt-chip.bad{border-top-color:var(--sell)}
.mkt-name{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mkt-chip strong{font-size:17px;font-variant-numeric:tabular-nums}
.mkt-chg{font-size:13px;font-weight:700}.mkt-chip.good .mkt-chg{color:var(--buy)}.mkt-chip.bad .mkt-chg{color:var(--sell)}.mkt-chip .spark{width:100%;height:28px}
.board-title{font-size:15px;margin:6px 0 10px}
.act-board{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:12px}
.act-card{--act:var(--muted);display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--line);border-inline-start:5px solid var(--act);border-radius:6px;min-width:0;background:var(--card)}
.act-card header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.act-card h3{margin:0;font-size:15px;line-height:1.4}
.act-pill{flex:none;padding:2px 10px;border-radius:12px;background:var(--act);color:#fff;font-size:12px;font-weight:700}
.act-exit{--act:var(--sell);background:linear-gradient(0deg,var(--card),var(--negative))}.act-reduce{--act:#c2410c}.act-tight{--act:var(--hold)}.act-hold{--act:var(--buy)}.act-none{--act:#8a94a3}
.act-price{display:flex;align-items:baseline;gap:10px}.act-price strong{font-size:20px;font-variant-numeric:tabular-nums}.act-price .pl{font-size:14px}
.act-stop{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:12px;color:var(--muted)}.act-stop bdi{color:var(--ink);font-weight:600}
.act-stop.near .act-dist{color:var(--sell);font-weight:700}.act-card .spark{width:100%;height:30px}
.act-reason{margin:0;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.idx-card .spark{width:100%;height:30px;margin-bottom:8px}
@media(max-width:900px){.report{padding:16px 24px}.report-header{grid-template-columns:1fr}.report-stamps{text-align:start}#report-summary-text{grid-template-columns:1fr;gap:10px}}
@media(max-width:640px){.report{padding:12px}.report-header h1{font-size:21px}.report>section{margin-block:18px;padding-bottom:18px}.section-nav{gap:0 18px}.section-nav a{min-height:42px}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px}.stat strong{font-size:24px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ranking-toolbar label{width:100%}.ranking-toolbar input{flex:1 1 160px}.card,.idx-card,.fc-card{padding:12px}h2{font-size:18px}.health-list{columns:1}.pick-main{padding-inline-start:12px}.mkt-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.act-board{grid-template-columns:1fr}.act-card .spark{height:26px}}
@media print{
@page{size:A4 landscape;margin:12mm}
body{background:#fff;font-size:10pt}.report{max-width:none;padding:0}
.ranking-toolbar,.sort-button span,.section-nav{display:none}.table-wrap{overflow:visible;max-height:none;border:0;scrollbar-gutter:auto}
table,.portfolio table,.evidence-table{min-width:0;width:100%;font-size:8pt;table-layout:fixed}
thead{display:table-header-group}thead th{position:static;white-space:normal}th,td{padding:5px!important;overflow-wrap:anywhere}
.num,.sym,.rank,.name,.evidence-table .num,.evidence-table th:first-child,.portfolio td:last-child{min-width:0;width:auto;white-space:normal}
.card,.fc-card,.idx-card,.sell-card,tr{break-inside:avoid;box-shadow:none}
.cards,.fc-cards,.idx-cards{display:block}.card,.fc-card,.idx-card{margin-bottom:12px}
.report>section{margin-block:14px;padding-block:0 10px}.report-header h1{font-size:20px}
.evidence-dates ul,.health-list,.full-summary-text{max-height:none;overflow:visible}a{color:inherit;text-decoration:underline}
}
`;

const INDEX_CSS = `
${WORKSPACE_CSS}
html,body{max-width:100%;overflow-x:hidden}
body{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:100vh}
.sidebar{display:flex;flex-direction:column;gap:16px;padding:24px 16px 16px;height:100dvh;position:sticky;top:0;min-width:0;background:var(--soft);border-inline-end:1px solid var(--line);border-top:4px solid var(--ink)}
.brand{padding-bottom:16px;border-bottom:1px solid var(--line)}.brand-market{font-size:11px;font-weight:700;color:var(--muted)}
.brand h1{font-size:20px;line-height:1.4;margin:6px 0 0}
.toggle{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));background:#e5e8ec;border-radius:5px;padding:3px;gap:3px}
.toggle button{min-height:40px;padding:6px;border:0;border-radius:3px;background:transparent;color:var(--muted);font-size:14px;font-weight:600;cursor:pointer}
.toggle button.active{background:var(--ink);color:#fff}.toggle button:hover:not(.active){background:var(--card);color:var(--ink)}
.run-box{display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--line);padding-bottom:16px}
.manage-link{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:42px;font-size:13px;font-weight:600;text-decoration:none;border-bottom:1px solid var(--ink)}
.manage-link:hover{color:var(--buy);border-color:var(--buy)}.manage-link span{font-size:18px}
.run-btn{min-height:40px;padding:8px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink);font-size:13px;font-weight:600;cursor:pointer}
.run-daily{background:var(--ink);color:#fff;border-color:var(--ink)}.run-btn:hover:not(:disabled){border-color:var(--muted)}.run-btn:disabled{opacity:.5;cursor:wait}
.run-status{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.run-status:empty{display:none}
.run-status.busy{color:var(--hold)}.run-status.ok{color:var(--buy)}.run-status.err{color:var(--sell)}
.app-actions{display:flex;flex-wrap:wrap;gap:8px}.app-btn{min-height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-size:13px;font-weight:600;cursor:pointer}
.install-btn{background:var(--buy);border-color:var(--buy);color:#fff}.help-btn:hover,.close-btn:hover,.app-btn:hover{border-color:var(--muted)}
.app-status{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.app-status[data-state="ready"]{color:var(--buy)}.app-status[data-state="warn"]{color:var(--hold)}.app-status[data-state="error"]{color:var(--sell)}
.archive-heading{margin:0;font-size:12px;font-weight:500;color:var(--muted)}
.report-list{display:flex;flex-direction:column;gap:4px;flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.report-item{display:flex;align-items:center;gap:8px;width:100%;text-align:right;min-height:44px;flex-shrink:0;padding:8px 10px;border:1px solid transparent;border-inline-start:3px solid transparent;border-radius:3px;background:transparent;color:var(--ink);font-size:13px;cursor:pointer}
.report-item:hover{background:#e9ecef}.report-item.selected{background:var(--card);border-color:var(--line);border-inline-start-color:var(--ink);font-weight:600}
.report-item .d{flex:1;direction:ltr;text-align:right}.report-item .latest{font-size:10px;padding:1px 5px;border-radius:2px;background:var(--positive);color:var(--buy)}
.no-reports{font-size:13px;color:var(--muted);margin:12px 0}.side-foot{font-size:10px;color:var(--muted);margin-top:auto}
.viewer{min-width:0;background:var(--card);display:grid;grid-template-rows:48px minmax(0,1fr);height:100dvh}
.viewer-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 24px;border-bottom:1px solid var(--line);background:var(--card);min-width:0}
.viewer-header p{margin:0;font-size:12px;font-weight:600;overflow-wrap:anywhere}.viewer-header a{font-size:12px;white-space:nowrap;text-decoration:none}.viewer-header a:hover{text-decoration:underline}
.viewer iframe{width:100%;height:100%;min-width:0;min-height:0;border:none;display:block;background:var(--card)}
.empty-state{display:flex;align-items:center;justify-content:center;color:var(--muted);min-height:0;background:repeating-linear-gradient(0deg,var(--soft),var(--soft) 39px,var(--line) 40px)}
.empty-state p{font-size:16px;background:var(--card);padding:12px 24px}
.app-dialog{inline-size:min(880px,calc(100vw - 24px));max-inline-size:calc(100vw - 24px);padding:0;border:0;border-radius:18px;background:var(--card);color:var(--ink)}
.app-dialog::backdrop{background:rgb(36 39 44 / 0.42)}.app-dialog-shell{display:flex;flex-direction:column;max-block-size:min(82dvh,860px);min-width:0}
.app-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 20px 16px;border-bottom:1px solid var(--line);background:linear-gradient(135deg,#f4f5f7,#eaf4ee)}
.app-dialog-kicker{margin:0 0 4px;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em}.app-dialog-head h2{margin:0;font-size:21px}
.app-dialog-body{display:grid;gap:16px;padding:0 20px 20px;overflow:auto;overscroll-behavior:contain}.help-section{padding-top:16px;border-top:1px solid var(--line)}.help-section:first-child{border-top:0}
.help-section h3,.help-section h4{margin:0 0 8px}.help-section p{margin:0 0 10px;font-size:13px;overflow-wrap:anywhere}.help-management{display:inline-flex;align-items:center;gap:8px;min-height:40px;font-size:13px;font-weight:600}
.help-fields,.help-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}.help-fields article,.help-grid article{min-width:0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}
@media(max-width:760px){body{display:block}.sidebar{position:static;height:auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 16px;padding:12px;border-inline-end:0;border-bottom:1px solid var(--line)}.brand{padding:0;border:0}.brand h1{font-size:17px;margin:2px 0 0}.brand-market{font-size:10px}.toggle{width:140px;align-self:center}.run-box{grid-column:1/-1;display:flex;flex-direction:row;align-items:center;flex-wrap:wrap;gap:8px 16px;padding-bottom:8px}.manage-link{min-height:36px;font-size:12px;gap:16px}.run-btn,.app-btn{font-size:12px;min-height:36px}.run-status,.app-status{width:100%}.archive-heading,.side-foot{display:none}.report-list{grid-column:1/-1;flex-direction:row;max-width:100%;overflow-x:auto;scrollbar-gutter:auto;padding-bottom:4px}.report-item{width:154px;min-height:40px;gap:6px}.viewer{height:calc(100dvh - 260px);min-height:480px;grid-template-rows:44px minmax(0,1fr)}.viewer-header{padding:8px 12px}.app-dialog{inline-size:min(calc(100vw - 12px),880px);max-inline-size:calc(100vw - 12px)}.app-dialog-head,.app-dialog-body{padding-inline:14px}.help-fields,.help-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:360px){.sidebar{column-gap:8px}.toggle{width:120px}.brand h1{font-size:16px}.brand-market{font-size:9px}}
@media screen and (max-width:760px){
body{min-height:100dvh}.sidebar{gap:8px 12px;padding:10px 12px}.brand h1{font-size:17px}.toggle{width:124px}.toggle button,.manage-link,.run-btn,.app-btn,.report-item,.help-management{min-height:44px}.run-box{gap:4px 12px;margin:0;padding-bottom:4px}.manage-link{font-size:13px;gap:8px}.app-btn{font-size:13px;border-radius:6px;padding:8px 10px}.app-status{font-size:11px;line-height:1.5}.report-list{margin:0;padding-bottom:2px;scroll-snap-type:x proximity}.report-item{width:140px;scroll-snap-align:start}.viewer{display:block;height:auto;min-height:0}.viewer-header{min-height:52px;padding:0 12px;gap:8px}.viewer-header a{display:flex;align-items:center;min-height:44px}.viewer iframe{height:75dvh;min-height:0}.empty-state{min-height:240px}.app-dialog{border-radius:8px}.app-dialog-head{padding-block:14px;gap:8px}.app-dialog-head h2{font-size:18px}.app-dialog-head .close-btn{flex-shrink:0}.help-fields article,.help-grid article{border-radius:6px}
}
@media print{body{display:block}.sidebar,.viewer-header{display:none}.viewer{display:block;height:auto}.viewer iframe{height:100vh}.empty-state{height:auto}}
`;
