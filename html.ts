/**
 * הפקת דוחות HTML מעוצבים ובניית עמוד index.html עם סרגל צד וניווט יומי/שבועי.
 */
import type { AnalysisResult, HorizonInfo, LongTermView } from "./analysis.js";
import type { IndexAnalysis, MarketStance } from "./indices.js";
import type { StockNews } from "./news.js";
import type { Mode, PickScorecard, PriceCheckEntry, SignalDelta } from "./report.js";
import type { ForecastResult, ForecastDirection, HistoricalForecast } from "./forecast.js";
import type { MarketRegime } from "./regime.js";
import type { CorrPair } from "./risk.js";
import type { BetaEntry } from "./runner.js";
import { selectDailyPick } from "./pick.js";
import { PORTFOLIO, STOCK_SECTORS, HELD_SECTORS, PARAMS, RISK } from "./config.js";
import { buildReportSummarySnapshot, type DataHealth, type ReportSummarySnapshot } from "./summary.js";

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
  scorecard?: PickScorecard;
  signalDeltas?: Map<string, SignalDelta>;
  historicalForecasts?: Map<string, HistoricalForecast>;
  dataHealth?: DataHealth;
  summary?: ReportSummarySnapshot;
}

const fmt = (n: number, digits = 2): string =>
  n.toLocaleString("he-IL", { maximumFractionDigits: digits });

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
      ? `<line x1="0" y1="${y(stop).toFixed(1)}" x2="${w}" y2="${y(stop).toFixed(1)}" class="spark-stop" />`
      : "";
  return `<svg class="spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="מגמת מחיר">${stopLine}<polyline points="${points}" /></svg>`;
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
  priceChecks?: PriceCheckEntry[]
): string {
  if (!PORTFOLIO.length) return "";
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));
  const idxBySymbol = new Map(indices.map((i) => [i.symbol, i]));
  const checkBySymbol = new Map((priceChecks ?? []).map((c) => [c.symbol, c]));

  const rows = PORTFOLIO.map((h) => {
    const r = h.symbol ? bySymbol.get(h.symbol) : undefined;
    // ניירות ללא ניתוח מלא: מחיר לפי סימול (Yahoo) או לפי שם ההחזקה (investing.com)
    const price = r?.price ?? (h.symbol ? extraPrices?.get(h.symbol) : undefined) ?? extraPrices?.get(h.name) ?? null;
    const plPct = price != null ? ((price - h.entryPrice) / h.entryPrice) * 100 : null;
    const plHtml =
      plPct != null
        ? `<span class="pl ${plPct >= 0 ? "up" : "down"}">${plPct >= 0 ? "▲" : "▼"} ${Math.abs(plPct).toFixed(1)}%</span>`
        : `<span class="pl na">—</span>`;

    let status: string;
    if (r) {
      status = `<span class="badge ${recClass(r.recommendation)}">${esc(r.recommendation)}</span> <span class="pf-score">ציון ${r.score} ${deltaHtml(r.symbol, r.score, prevScores)}</span>`;
      const hz = horizons?.get(r.symbol);
      if (hz) {
        status += `<div class="pf-hz">שבועי ${hz.weeklyScore ?? "—"} · ארוך ${hz.longTerm?.label ?? "—"} · משולב <strong>${hz.combined}</strong>${hz.alignment === "מלאה" ? " 🚀" : ""}</div>`;
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
    } else if (h.triggerIndex) {
      const idx = idxBySymbol.get(h.triggerIndex);
      if (idx) {
        const ok = idx.indicators.trendUp;
        status = `<span class="badge ${stanceClass(idx.stance)}">${esc(idx.stance)}</span> <span class="pf-trigger ${ok ? "ok" : "warn"}">${ok ? `✅ ממוצע ${PARAMS.smaShort} מעל ${PARAMS.smaLong}` : `⚠️ ממוצע ${PARAMS.smaShort} מתחת ל-${PARAMS.smaLong}`} (${esc(idx.name)})</span>`;
      } else {
        status = `<span class="pf-trigger na">אין נתוני מדד ייחוס עדיין</span>`;
      }
    } else {
      status = `<span class="pf-trigger na">אין ניתוח טכני זמין</span>`;
    }

    if (!r) status += `<div class="coverage-note">${price != null ? "מחיר בלבד" : "מחיר חסר"}; ללא ציון או סטופ. מדד ייחוס אינו ניתוח של הקרן.</div>`;

    if (h.alertBelow != null && price != null && price < h.alertBelow) {
      status += `<div class="pf-alert">🚨 מתחת לרמת הבקרה (${h.alertBelow.toLocaleString("he-IL")}) — לשקול בחינה מחדש</div>`;
    }

    const chart = h.symbol ? sparkline(sparkCloses?.get(h.symbol), r?.risk?.stop ?? r?.sequenceStop ?? null) : "";

    return `<tr>
      <td class="name">${esc(h.name)}${h.note ? ` <small>${esc(h.note)}</small>` : ""}</td>
      <td class="num">${h.entryPrice.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</td>
      <td class="num">${price != null ? price.toLocaleString("he-IL", { maximumFractionDigits: 2 }) : "—"}</td>
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

/**
 * המלצות מכירה — התראות יציאה על ההחזקות בתיק (מנוקדות לפי חומרה) ואיתותי מכירה טריים
 * במניות שבמעקב. קרנות סל ממונפות אינן נכללות כאן — עבורן מוצג מעקב טריגרים בלבד.
 */
function renderSellSection(
  results: AnalysisResult[],
  horizons?: Map<string, HorizonInfo>,
  news?: Map<string, StockNews>
): string {
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));

  type Alert = { name: string; symbol: string; price: number; severity: number; reasons: string[]; stop: number | null };
  const held: Alert[] = [];

  for (const h of PORTFOLIO) {
    if (!h.symbol) continue;
    const r = bySymbol.get(h.symbol);
    if (!r) continue;
    const hz = horizons?.get(r.symbol);
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
    const plPct = ((r.price - h.entryPrice) / h.entryPrice) * 100;
    if (plPct > 8 && (r.indicators.stochK ?? 0) >= 90 && (r.indicators.rsi ?? 0) >= 68) {
      severity += 1;
      reasons.push(`רווח ${plPct.toFixed(1)}% עם מתיחות קיצונית (סטוכסטי ${r.indicators.stochK?.toFixed(0)}, RSI ${r.indicators.rsi?.toFixed(0)}) — לשקול מימוש חלקי.`);
    }

    if (severity >= 3) held.push({ name: h.name, symbol: r.symbol, price: r.price, severity, reasons, stop: r.risk?.stop ?? r.sequenceStop });
  }

  held.sort((a, b) => b.severity - a.severity);

  const heldHtml = held.length
    ? held
        .map((a) => {
          const level = a.severity >= 5 ? "מכירה / יציאה" : a.severity >= 4 ? "צמצום פוזיציה" : "סטופ הדוק";
          const cls = a.severity >= 5 ? "sell-urgent" : a.severity >= 4 ? "sell-reduce" : "sell-watch";
          const stopLine = a.stop != null
            ? `<p class="sell-stop">רמת יציאה: <strong>${a.stop.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</strong> — סגירה מתחתיה = יציאה.</p>`
            : "";
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

/** המלצת הרכישה היומית — המועמדות הטובות ביותר בשקלול שלושת האופקים, עם התחשבות בחפיפה לתיק. */
function renderDailyPickSection(
  results: AnalysisResult[],
  horizons?: Map<string, HorizonInfo>,
  regime?: MarketRegime | null
): string {
  if (!horizons || horizons.size === 0) return "";
  const sel = selectDailyPick(results, horizons, regime);

  const overlapNote = (sym: string): string => {
    const sector = STOCK_SECTORS[sym];
    return sector && HELD_SECTORS.includes(sector)
      ? `<div class="pick-overlap">⚠️ חפיפה סקטוריאלית: התיק כבר חשוף לסקטור ה${esc(sector)}</div>`
      : "";
  };

  const breakdown = (x: { r: AnalysisResult; hz: HorizonInfo }): string =>
    `יומי <strong>${x.r.score}</strong> · שבועי <strong>${x.hz.weeklyScore ?? "—"}</strong> · ארוך ${ltBadge(x.hz.longTerm)} · התכנסות: ${x.hz.alignment}${x.hz.alignment === "מלאה" ? " 🚀" : ""}`;

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
      ${overlapNote(m.r.symbol)}
      ${rsNote}
      ${riskBox(m.r)}
      <ul class="signals">${topSignals}</ul>
    </div>`;
  } else {
    mainHtml = `<p class="empty">אף מועמדת לא עוברת היום את ספי האיכות (משולב ≥${sel.threshold}, יומי ≥15, נזילות גבוהה, יחס סיכוי/סיכון ≥${RISK.minRR}) — עדיף להמתין ולא לכפות קנייה.</p>`;
  }

  const altsHtml = sel.alts.length
    ? `<div class="pick-alts"><h4>חלופות נוספות</h4><ul>${sel.alts
        .map(
          (x) =>
            `<li><strong>${esc(x.r.name)}</strong> <small>${esc(x.r.symbol)}</small> — ${breakdown(x)}${
              x.r.risk ? ` · סטופ ${fmt(x.r.risk.stop)} · סיכוי/סיכון ${x.r.risk.rr.toFixed(1)}` : ""
            }${overlapNote(x.r.symbol)}</li>`
        )
        .join("")}</ul></div>`
    : "";

  const strengthenHtml = sel.strengthen
    ? `<p class="pick-strength">💪 חיזוק החזקה קיימת: <strong>${esc(sel.strengthen.r.name)}</strong> — ${breakdown(sel.strengthen)}</p>`
    : "";

  const rejectedHtml = sel.rejected.length
    ? `<details class="pick-rejected"><summary>מועמדות שנפסלו על ניהול סיכון (${sel.rejected.length})</summary><ul>${sel.rejected
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
function renderIndicesSection(indices: IndexAnalysis[], historicalForecasts?: Map<string, HistoricalForecast>): string {
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
  } = input;
  const hasHz = !!horizons && horizons.size > 0;
  const title = mode === "daily"
    ? (hasHz ? "דוח משולב — יומי · שבועי · ארוך טווח" : "דוח המלצות יומי")
    : "דוח המלצות שבועי";
  const hzOf = (sym: string) => horizons?.get(sym);
  // מיון לפי הציון המשולב כשיש אופקים, אחרת לפי הציון היומי
  const sortKey = (r: AnalysisResult) => hzOf(r.symbol)?.combined ?? r.score;
  const sorted = [...results].sort((a, b) => sortKey(b) - sortKey(a));

  const indicesHtml = renderIndicesSection(indices, historicalForecasts);
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
    priceChecks
  );
  const pickHtml = renderDailyPickSection(results, horizons, regime);
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
        <td class="num"><strong>${hz?.combined ?? "—"}</strong></td>`
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
  const rankingColumns = ["#", "מניה", "סימול", "מחיר", "ציון", "Δ", ...(hasHz ? ["שבועי", "ארוך", "משולב"] : []), "המלצה", "RSI", "Stoch", "ADX", "מגמה", "חדשות"];
  const numericColumns = new Set(["#", "מחיר", "ציון", "Δ", "שבועי", "משולב", "RSI", "Stoch", "ADX"]);
  const health = summary.dataHealth;
  const barDates = [...new Set(Object.values(health?.latestBarDates ?? {}).filter((date): date is string => !!date && /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  const freshness = barDates.length ? `${barDates[0]}${barDates.length > 1 ? ` / ${barDates[barDates.length - 1]}` : ""}` : "לא מתועד";
  const partial = health && (health.analyzed < health.expected || health.missingSymbols.length > 0 || Object.keys(health.failures).length > 0);
  const coverage = health ? `${health.analyzed} מתוך ${health.expected} מניות נותחו` : `${results.length} מניות נותחו; היקף האיסוף אינו מתועד`;
  const analyzedHoldings = summary.portfolio.filter((holding) => holding.coverage === "analyzed").length;
  const flaggedHoldings = summary.portfolio.filter((holding) => holding.alerts.length);
  const dateLabel = generatedAt.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "medium", timeStyle: "short" });
  const pick = horizons?.size ? selectDailyPick(results, horizons, regime).main : null;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)} — ${esc(generatedAt.toLocaleDateString("he-IL"))}</title>
${FONT_LINK}
<style>${REPORT_CSS}</style>
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
    <p class="freshness-note">זמן ההפקה אינו זמן הציטוט; המחירים אינם נתוני זמן אמת.</p>
  </header>

  <nav class="section-nav" aria-label="ניווט בדוח">
    <a href="#summary">תקציר</a><a href="#alerts">התראות</a><a href="#portfolio">התיק שלי</a><a href="#rankings">דירוג מניות</a><a href="#evidence">ראיות</a><a href="#data-health">נתונים</a>
  </nav>

  <section id="summary" class="executive" aria-labelledby="summary-title">
    <div class="section-heading"><h2 id="summary-title">תמונת מצב</h2><a class="health-status ${partial || !results.length ? "warn" : ""}" href="#data-health">${!results.length ? "אין תוצאות ניתוח" : partial ? "איסוף חלקי" : health ? "נתוני איסוף" : "כיסוי לא מתועד"}</a></div>
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

  ${pickHtml}

  ${regimeHtml}

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
        <caption>סדר ברירת מחדל: ${hasHz ? "ציון משולב" : "ציון טכני"}</caption>
        <thead><tr>
          ${rankingColumns.map((label, column) => `<th scope="col" aria-sort="none"><button type="button" class="sort-button" data-column="${column}" data-numeric="${numericColumns.has(label)}" aria-label="מיון לפי ${esc(label)}">${esc(label)} <span aria-hidden="true">↕</span></button></th>`).join("")}
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <p id="ranking-empty" class="empty" hidden>אין מניות תואמות לחיפוש.</p>
  </section>

  <section class="buy-section">
    <h2>מומלצות לרכישה</h2>
    <details id="buy-catalog"><summary>כל המועמדות לרכישה <span class="catalog-count">${buyCount}</span></summary><div class="cards">${buyCards}</div></details>
  </section>

  ${renderPortfolioEvidence(historicalForecasts)}
  ${scorecardHtml}
  ${corrHtml}

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
@media(max-width:900px){.report{padding:16px 24px}.report-header{grid-template-columns:1fr}.report-stamps{text-align:start}#report-summary-text{grid-template-columns:1fr;gap:10px}}
@media(max-width:640px){.report{padding:12px}.report-header h1{font-size:21px}.report>section{margin-block:18px;padding-bottom:18px}.section-nav{gap:0 18px}.section-nav a{min-height:42px}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px}.stat strong{font-size:24px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ranking-toolbar label{width:100%}.ranking-toolbar input{flex:1 1 160px}.card,.idx-card,.fc-card{padding:12px}h2{font-size:18px}.health-list{columns:1}.pick-main{padding-inline-start:12px}}
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
