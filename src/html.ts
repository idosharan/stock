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
  return `<section class="portfolio-evidence"><h2>ראיות היסטוריות לתיק</h2>${PORTFOLIO.map((holding) => {
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
      status = `<span class="pf-trigger na">אין ניתוח מלא עדיין (היסטוריה קצרה)</span>`;
    }

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

  return `<section class="portfolio">
    <h2>💼 התיק שלי — בדיקה יומית</h2>
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
    <h2>🧭 מצב שוק ורוחב שוק</h2>
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
    <h2>📈 כרטיס ציונים — ביצועי ההמלצות הקודמות</h2>
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
    <h2>🔗 ריכוזיות התיק — מתאם ובטא</h2>
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
    : `<p class="empty">אין היום איתות מכירה על ההחזקות בתיק — כל הפוזיציות מעל רמות היציאה שלהן.</p>`;

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

  return `<section class="sell">
    <h2>🔻 המלצות מכירה / יציאה</h2>
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
    <h2>🛒 המלצת הרכישה של היום</h2>
    ${regimeNote}
    ${mainHtml}
    ${altsHtml}
    ${strengthenHtml}
    ${rejectedHtml}
  </section>`;
}

const REGION_ORDER = ['ארה"ב', "ישראל", "אירופה", "אסיה"];
const REGION_ICON: Record<string, string> = {
  'ארה"ב': "🇺🇸",
  ישראל: "🇮🇱",
  אירופה: "🇪🇺",
  אסיה: "🌏",
};

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
        <h3>${REGION_ICON[region] ?? "🌐"} ${esc(region)}</h3>
        <div class="idx-cards">${cards}</div>
      </div>`;
    })
    .join("");

  return `<section>
    <h2>🌍 סקירת מדדי עולם והמלצות מגמה</h2>
    <p class="idx-intro">ניתוח טכני של מדדי מניות מובילים — ארה"ב, ישראל, אירופה (DAX) ואסיה. ההמלצות מתייחסות למגמת המדד ולא לנייר בודד.</p>
    ${blocks}
  </section>`;
}

/** מפיק מסמך HTML עצמאי ומעוצב עבור דוח בודד. */
export function renderReportHtml(input: ReportHtmlInput): string {
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
  <header class="hero">
    <span class="tag ${mode === "daily" ? "tag-daily" : "tag-weekly"}">${
    mode === "daily" ? "יומי" : "שבועי"
  }</span>
    <h1>${esc(title)}</h1>
    <p class="subtitle">ניתוח טכני · בורסת תל אביב · ${
      mode === "daily"
        ? (hasHz ? "שלושה אופקי זמן: נרות יומיים · שבועיים · מגמה ארוכת טווח (SMA200)" : "נרות יומיים")
        : "נרות שבועיים (מגמה שבועית)"
    }</p>
    <p class="generated">נוצר אוטומטית: ${esc(generatedAt.toLocaleString("he-IL"))}</p>
  </header>

  <section class="stats">
    <div class="stat stat-buy"><strong>${buyCount}</strong><span>קנייה</span></div>
    <div class="stat stat-hold"><strong>${holdCount}</strong><span>החזקה</span></div>
    <div class="stat stat-sell"><strong>${sellCount}</strong><span>מכירה / הימנעות</span></div>
    <div class="stat stat-total"><strong>${sorted.length}</strong><span>סה"כ במעקב</span></div>
  </section>

  ${portfolioHtml}

  ${renderPortfolioEvidence(historicalForecasts)}

  ${regimeHtml}

  ${pickHtml}

  ${sellHtml}

  ${scorecardHtml}

  ${corrHtml}

  <div class="disclaimer">
    ⚠️ הדוח מבוסס על ניתוח טכני אוטומטי ואינו מהווה ייעוץ השקעות. השקעה בניירות ערך כרוכה
    בסיכון. יש להתייעץ עם יועץ מורשה לפני קבלת החלטות.
  </div>
  ${forecastHtml}
  ${indicesHtml}

  <section>
    <h2>🎯 מומלצות לרכישה</h2>
    <div class="cards">${buyCards}</div>
  </section>

  <section>
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

  <section>
    <h2>פירוט מלא לכל המניות</h2>
    <div class="details">${detailRows}</div>
  </section>

  <footer class="report-foot">© ${generatedAt.getFullYear()} TASE Analyst Agent</footer>
</main>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}

export interface IndexReportEntry {
  mode: Mode;
  date: string; // YYYY-MM-DD
  file: string; // file name
}

/** בונה את עמוד index.html עם סרגל צד וניווט יומי/שבועי. */
export function buildIndexHtml(entries: IndexReportEntry[]): string {
  const data = JSON.stringify(entries).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>דוחות ניתוח טכני — בורסת ת"א</title>
${FONT_LINK}
<style>${INDEX_CSS}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand">
    <div>
      <h1>TASE Analyst</h1>
      <p>דוחות ניתוח טכני</p>
    </div>
  </div>

  <div class="toggle" role="tablist" aria-label="סוג דוח">
    <button id="btn-daily" role="tab" aria-selected="true" aria-controls="report-list" class="active" onclick="setMode('daily')">יומי</button>
    <button id="btn-weekly" role="tab" aria-selected="false" aria-controls="report-list" tabindex="-1" onclick="setMode('weekly')">שבועי</button>
  </div>

  <div class="run-box">
    <button id="run-daily" class="run-btn run-daily" onclick="runReport('daily')">▶ הרץ דוח יומי</button>
    <button id="run-weekly" class="run-btn run-weekly" onclick="runReport('weekly')">▶ הרץ דוח שבועי</button>
    <div id="run-status" class="run-status" role="status" aria-live="polite"></div>
  </div>

  <nav id="report-list" class="report-list" role="tabpanel" aria-labelledby="btn-daily" tabindex="0"></nav>
  <footer class="side-foot">© ${new Date().getFullYear()} TASE Analyst Agent</footer>
</aside>

<main class="viewer">
  <div id="empty-state" class="empty-state">
    <p>אין דוחות זמינים</p>
  </div>
  <iframe id="frame" title="דוח" style="display:none"></iframe>
</main>

<script>
const REPORTS = ${data};
let currentMode = 'daily';

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
}

async function runReport(mode) {
  const status = document.getElementById('run-status');
  const btns = document.querySelectorAll('.run-btn');
  const isStatic = location.protocol === 'file:' ||
    location.hostname.endsWith('github.io') ||
    location.hostname.endsWith('github.dev');
  // בסביבה סטטית (GitHub Pages / פתיחת קובץ) אין שרת שמריץ Node.js.
  if (isStatic) {
    status.className = 'run-status err';
    const host = location.hostname;
    // ניחוש כתובת מאגר ה-GitHub מתוך כתובת ה-Pages (user.github.io/repo).
    let actionsUrl = '';
    if (host.endsWith('github.io')) {
      const user = host.replace('.github.io', '');
      const repo = location.pathname.split('/').filter(Boolean)[0] || (user + '.github.io');
      actionsUrl = 'https://github.com/' + encodeURIComponent(user) + '/' + encodeURIComponent(repo) + '/actions';
    }
    status.innerHTML =
      'הפקת דוח חדש כאן רצה בענן דרך <b>GitHub Actions</b>:' +
      (actionsUrl
        ? '<br><a href="' + actionsUrl + '" target="_blank" rel="noopener">פתח/י את לשונית Actions</a> → "Build &amp; Deploy Reports" → Run workflow.'
        : '<br>פתח/י את לשונית <b>Actions</b> במאגר → "Build &amp; Deploy Reports" → Run workflow.') +
      '<br>או הרצה מקומית: <code>npm run web</code>';
    return;
  }
  btns.forEach(b => b.disabled = true);
  status.className = 'run-status busy';
  status.innerHTML = '<span class="spin"></span> מריץ דוח ' + (mode === 'daily' ? 'יומי' : 'שבועי') + '... זה עשוי לקחת כמה דקות';
  try {
    const res = await fetch('/api/run?mode=' + mode, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'שגיאה לא ידועה');
    status.className = 'run-status ok';
    status.textContent = '✓ הדוח הופק בהצלחה — טוען מחדש...';
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    status.className = 'run-status err';
    status.textContent = '✗ ' + err.message;
    btns.forEach(b => b.disabled = false);
  }
}

renderList();
</script>
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
:root{--bg:#f5f7f6;--card:#fff;--ink:#252b2a;--muted:#596560;--line:#d9e1de;
--buy:#147568;--strongbuy:#095e53;--hold:#895c12;--sell:#b23b3b;--accent:#086b63;--soft:#edf4f1}
html{color-scheme:light}
body{font-family:"Heebo","Noto Sans Hebrew","Tahoma",sans-serif;letter-spacing:0;background:var(--bg);color:var(--ink)}
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
:root{--bg:#0f172a;--card:#fff;--ink:#1e293b;--muted:#64748b;--line:#e2e8f0;
--buy:#16a34a;--strongbuy:#15803d;--hold:#d97706;--sell:#dc2626;--accent:#2563eb;}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI","Assistant",system-ui,Arial,sans-serif;
background:#f1f5f9;color:var(--ink);line-height:1.6}
.report{max-width:1100px;margin:0 auto;padding:24px}
.hero{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-radius:20px;
padding:32px;box-shadow:0 10px 30px rgba(37,99,235,.25);position:relative;overflow:hidden}
.hero h1{margin:8px 0 4px;font-size:30px}
.subtitle{margin:0;opacity:.9}
.generated{margin:12px 0 0;font-size:13px;opacity:.8}
.tag{display:inline-block;padding:4px 14px;border-radius:999px;font-size:13px;font-weight:700;
background:rgba(255,255,255,.2)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:20px 0}
.stat{background:var(--card);border-radius:14px;padding:18px;text-align:center;
box-shadow:0 2px 8px rgba(0,0,0,.05);border-top:4px solid var(--accent)}
.stat strong{display:block;font-size:28px}.stat span{color:var(--muted);font-size:13px}
.stat-buy{border-color:var(--buy)}.stat-hold{border-color:var(--hold)}
.stat-sell{border-color:var(--sell)}.stat-total{border-color:var(--accent)}
.disclaimer{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:12px;
padding:14px 18px;font-size:14px;margin-bottom:24px}
.forecast{background:linear-gradient(135deg,#0f172a,#1e293b);color:#e2e8f0;border-radius:20px;
padding:26px;margin:24px 0;box-shadow:0 10px 30px rgba(15,23,42,.25)}
.forecast h2{color:#fff;border-right-color:#38bdf8;margin:0 0 12px}
.fc-intro{font-size:15px;margin:0 0 18px;color:#cbd5e1}
.fc-tone{display:inline-block;margin-right:6px;padding:2px 10px;border-radius:999px;
background:rgba(56,189,248,.18);color:#7dd3fc;font-size:13px;font-weight:700}
.fc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.fc-card{background:rgba(255,255,255,.05);border:1px solid rgba(148,163,184,.25);
border-radius:16px;padding:18px}
.fc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.fc-head h3{margin:0;font-size:19px;color:#fff}
.fc-horizon{margin:0 0 12px;font-size:13px;color:#94a3b8}
.fc-block{margin-top:12px}
.fc-block h4{margin:0 0 6px;font-size:14px;color:#7dd3fc}
.fc-block ul{margin:0;padding-right:18px;font-size:13.5px;color:#cbd5e1}
.fc-block li{margin-bottom:4px}
.fc-note{margin:16px 0 0;font-size:12px;color:#94a3b8}
h2{font-size:22px;margin:32px 0 16px;padding-right:12px;border-right:4px solid var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.card{background:var(--card);border-radius:16px;padding:18px;box-shadow:0 4px 14px rgba(0,0,0,.06);
border:1px solid var(--line);transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-3px);box-shadow:0 10px 24px rgba(0,0,0,.1)}
.card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.card-head h3{margin:0;font-size:18px;flex:1}
.card-head small{color:var(--muted);font-weight:400;font-size:13px}
.card-score{font-weight:700;color:var(--accent)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}
.metrics div{background:#f8fafc;border-radius:10px;padding:8px;text-align:center}
.metrics span{display:block;color:var(--muted);font-size:11px}
.metrics strong{font-size:15px}
.signals{margin:8px 0 0;padding-right:18px;font-size:14px;color:#334155}
.signals li{margin:2px 0}
.news{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px;font-size:13px}
.news-title{font-weight:700;color:var(--muted)}
.news ul{margin:6px 0 0;padding-right:18px}.news a{color:var(--accent);text-decoration:none}
.news a:hover{text-decoration:underline}.news em{color:var(--muted);font-style:normal;font-size:12px}
.badge{display:inline-block;padding:3px 12px;border-radius:999px;font-size:13px;font-weight:700;color:#fff}
.rec-strong-buy{background:var(--strongbuy)}.rec-buy{background:var(--buy)}
.rec-hold{background:var(--hold)}.rec-sell{background:var(--sell)}
.table-wrap{overflow-x:auto;background:var(--card);border-radius:16px;
box-shadow:0 4px 14px rgba(0,0,0,.06);border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{background:#f8fafc;padding:12px 10px;text-align:right;color:var(--muted);
font-weight:700;border-bottom:2px solid var(--line);position:sticky;top:0}
tbody td{padding:10px;border-bottom:1px solid var(--line)}
tbody tr:hover{background:#f8fafc}
.num{text-align:left;font-variant-numeric:tabular-nums}.center{text-align:center}
.rank{color:var(--muted);font-weight:700}.name{font-weight:600}.sym{color:var(--muted);font-size:13px}
.score{display:inline-block;min-width:30px;text-align:center;font-weight:700}
.empty{color:var(--muted);background:var(--card);padding:20px;border-radius:12px}
.details{display:grid;gap:8px}
.detail{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px}
.detail summary{cursor:pointer;padding:10px 0;font-weight:600}
.detail ul{margin:0 0 12px;padding-right:18px;font-size:14px;color:#334155}
.report-foot{text-align:center;color:var(--muted);font-size:13px;margin-top:32px;padding:16px}
@media(max-width:640px){.stats,.metrics{grid-template-columns:repeat(2,1fr)}.hero h1{font-size:24px}}
.idx-intro{color:var(--muted);font-size:14px;margin:-6px 0 16px}
.idx-region{margin-bottom:24px}
.idx-region h3{font-size:18px;margin:0 0 12px;color:#0f172a}
.idx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.idx-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;
box-shadow:0 3px 10px rgba(0,0,0,.05)}
.idx-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.idx-head h4{margin:0;font-size:16px}.idx-head small{color:var(--muted);font-weight:400;font-size:12px}
.idx-row{display:flex;align-items:center;gap:10px;margin:10px 0 6px}
.idx-price{font-size:20px;font-weight:700}
.idx-chg{font-size:14px;font-weight:700}.idx-chg.up{color:var(--buy)}.idx-chg.down{color:var(--sell)}
.idx-score{margin-inline-start:auto;color:var(--accent);font-weight:700;font-size:13px}
.idx-rec{background:#f1f5f9;border-radius:8px;padding:6px 10px;font-size:13px;font-weight:600;margin-bottom:8px}
.idx-metrics{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.idx-metrics span{background:#f8fafc;border-radius:7px;padding:4px 8px;font-size:12px;color:#475569}
.idx-signals{margin:0;padding-right:18px;font-size:13px;color:#334155}
.idx-signals li{margin:2px 0}
.delta{font-size:12px;font-weight:700;margin-inline-start:4px}
.delta.up{color:var(--buy)}.delta.down{color:var(--sell)}
.delta.flat,.delta.na{color:var(--muted)}
.portfolio h2{border-right-color:#7c3aed}
.portfolio .name small{color:var(--muted);font-weight:400;font-size:12px}
.portfolio td .badge{font-size:12px}
.pl{font-weight:700}.pl.up{color:var(--buy)}.pl.down{color:var(--sell)}.pl.na{color:var(--muted)}
.pf-score{font-size:13px;color:var(--muted);font-weight:600;white-space:nowrap}
.pf-trigger{font-size:13px;font-weight:600}
.pf-trigger.ok{color:var(--buy)}.pf-trigger.warn{color:#b45309}.pf-trigger.na{color:var(--muted)}
.pf-hz{margin-top:4px;font-size:12.5px;color:var(--muted)}
.pf-hz strong{color:var(--accent)}
.pf-alert{margin-top:4px;font-size:13px;font-weight:700;color:var(--sell)}
.lt{font-size:12.5px;font-weight:700}
.lt.pos{color:var(--buy)}.lt.neg{color:var(--sell)}.lt.neu,.lt.na{color:var(--muted)}
.pick h2{border-right-color:#0891b2}
.pick-main{background:linear-gradient(135deg,#ecfeff,#f0fdfa);border:1px solid #a5f3fc;border-radius:16px;
padding:20px;box-shadow:0 4px 14px rgba(8,145,178,.1)}
.pick-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.pick-head h3{margin:0;font-size:20px;flex:1}
.pick-head small{color:var(--muted);font-weight:400}
.pick-label{background:#0891b2;color:#fff;padding:4px 14px;border-radius:999px;font-size:13px;font-weight:700}
.pick-combined{font-size:18px;font-weight:800;color:#0e7490}
.pick-breakdown{margin:10px 0 4px;font-size:14.5px;color:#334155}
.pick-overlap{margin:8px 0 0;font-size:13.5px;font-weight:600;color:#b45309}
.pick-alts{margin-top:14px}
.pick-alts h4{margin:0 0 8px;font-size:15px;color:var(--muted)}
.pick-alts ul{margin:0;padding-right:18px;font-size:14px}
.pick-alts li{margin-bottom:8px}
.pick-strength{margin:14px 0 0;font-size:14.5px;background:var(--card);border:1px solid var(--line);
border-radius:12px;padding:12px 16px}
.sell h2{border-right-color:var(--sell)}
.sell-card{background:#fef2f2;border:1px solid #fecaca;border-radius:14px;padding:16px 18px;margin-bottom:12px}
.sell-card.sell-reduce{background:#fff7ed;border-color:#fed7aa}
.sell-card.sell-watch{background:#fffbeb;border-color:#fde68a}
.sell-card header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sell-card h3{margin:0;font-size:18px;flex:1}
.sell-card h3 small{color:var(--muted);font-weight:400}
.sell-level{background:var(--sell);color:#fff;padding:4px 14px;border-radius:999px;font-size:13px;font-weight:700}
.sell-card.sell-reduce .sell-level{background:#ea580c}
.sell-card.sell-watch .sell-level{background:#b45309}
.sell-price{font-size:14px;font-weight:700;color:#334155}
.sell-stop{margin:8px 0 0;font-size:13.5px;color:#334155}
.sell-watchlist{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.sell-watchlist h4{margin:0 0 8px;font-size:15px;color:var(--muted)}
.sell-watchlist ul{margin:0;padding-right:18px;font-size:14px}
.sell-watchlist li{margin-bottom:6px}
.pf-risk{margin-top:4px;font-size:12.5px;color:#0f766e;font-weight:600}
.pf-delta{margin-top:6px;font-size:12.5px}
.pf-delta summary{cursor:pointer;color:var(--muted);font-weight:600}
.pf-delta ul{margin:6px 0 0;padding-right:16px}
.pf-delta .add{color:var(--buy)}
.pf-delta .rem{color:var(--muted)}
.spark-cell{width:130px}
.spark{display:block}
.spark polyline{fill:none;stroke-width:1.6}
.spark.up polyline{stroke:var(--buy)}
.spark.down polyline{stroke:var(--sell)}
.spark-stop{stroke:#f59e0b;stroke-width:1;stroke-dasharray:3 3}
.regime h2{border-right-color:#7c3aed}
.regime-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.regime-score{font-weight:800;font-size:17px;color:#5b21b6}
.regime-bench{color:var(--muted);font-size:14px}
.regime-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:10px}
.regime-metrics div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;
display:flex;flex-direction:column}
.regime-metrics span{font-size:12.5px;color:var(--muted)}
.regime-metrics strong{font-size:18px}
.risk-box{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}
.risk-box div{background:#fff;border:1px solid #a5f3fc;border-radius:12px;padding:10px 14px;
display:flex;flex-direction:column;gap:2px}
.risk-box span{font-size:12.5px;color:var(--muted)}
.risk-box strong{font-size:17px}
.risk-box strong.up{color:var(--buy)}.risk-box strong.down{color:var(--sell)}
.risk-box small{font-size:11.5px;color:var(--muted)}
.pick-regime{margin:0 0 12px;font-size:14px;font-weight:600;color:#5b21b6}
.pick-rs{margin-top:6px;font-size:13.5px;color:#0f766e;font-weight:600}
.pick-rejected{margin-top:12px;font-size:13.5px}
.pick-rejected summary{cursor:pointer;color:var(--muted);font-weight:600}
.pick-rejected ul{margin:8px 0 0;padding-right:18px}
.scorecard h2{border-right-color:#16a34a}
.score-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.score-summary div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;
display:flex;flex-direction:column}
.score-summary span{font-size:12.5px;color:var(--muted)}
.score-summary strong{font-size:18px}
.score-summary strong.up{color:var(--buy)}.score-summary strong.down{color:var(--sell)}
.corr h2{border-right-color:#db2777}
.corr-high td{background:#fef2f2}
.corr-mid td{background:#fff7ed}
.beta-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:12px}
.beta-list div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;
display:flex;flex-direction:column}
.beta-list span{font-size:12.5px;color:var(--muted)}
.beta-list strong{font-size:17px}
.beta-list small{font-size:11.5px;color:var(--muted)}
.note{font-size:13px;color:var(--muted);margin-top:8px}
${WORKSPACE_CSS}
.report{max-width:1440px;padding:24px 32px;min-width:0}
.report>section{min-width:0;margin-block:24px;padding-block:4px 20px;border-bottom:1px solid var(--line)}
.hero{background:transparent;color:var(--ink);padding:4px 0 20px;border-radius:0;box-shadow:none;border-bottom:2px solid var(--ink);overflow:visible}
.hero h1{font-size:26px;line-height:1.35;margin:12px 0 8px;font-weight:700}
.subtitle,.generated{color:var(--muted);opacity:1;overflow-wrap:anywhere}
.tag{background:var(--soft);color:var(--accent);border-radius:4px;padding:2px 10px}
.stats{gap:0;background:transparent}
.stat{padding:10px 16px;text-align:right;border-radius:0;box-shadow:none;background:transparent;border-top-width:2px;border-inline-end:1px solid var(--line)}
.stat:last-child{border-inline-end:0}.stat strong{font-size:24px;line-height:1.4}
h2{font-size:20px;line-height:1.4;margin:20px 0 14px;border-right-width:3px;color:var(--ink)}
.portfolio h2,.regime h2,.corr h2,.scorecard h2,.pick h2{border-right-color:var(--accent)}
.disclaimer{border-radius:4px;background:#fcf8ee;border-color:#e9d9b4;color:#785115;padding:10px 14px}
.forecast{background:transparent;color:var(--ink);border-radius:0;padding:0;box-shadow:none}
.forecast h2{color:var(--ink);border-right-color:var(--accent)}
.fc-intro,.fc-block ul{color:var(--ink)}
.fc-horizon,.fc-note{color:var(--muted)}
.fc-head h3{color:var(--ink);font-size:18px}.fc-block h4{color:var(--accent)}
.fc-tone{background:var(--soft);color:var(--accent);border-radius:4px}
.cards,.fc-cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}
.card,.fc-card,.idx-card,.sell-card{border:1px solid var(--line);border-radius:6px;box-shadow:none;background:var(--card);min-width:0}
.card{transition:none}.card:hover{transform:none;box-shadow:none}
.card-head h3,.pick-head h3,.sell-card h3{flex:1 1 160px;overflow-wrap:anywhere}
.card-head small,.idx-head small{display:inline-block;direction:ltr;unicode-bidi:isolate}
.metrics{grid-template-columns:repeat(4,minmax(0,1fr));gap:0}
.metrics div{background:transparent;border-radius:0;border-bottom:1px solid var(--line);padding:8px 4px;min-width:0}
.metrics strong{font-size:14px;overflow-wrap:anywhere}
.signals,.detail ul,.idx-signals,.pick-breakdown,.sell-price,.sell-stop{color:var(--ink)}
.signals,.news,.fc-block,.idx-signals,.historical-evidence{overflow-wrap:anywhere}
.badge,.pick-label,.sell-level{border-radius:4px;padding:3px 9px}
.table-wrap{max-width:100%;max-height:70vh;overflow:auto;overscroll-behavior-inline:contain;border:1px solid var(--line);border-radius:4px;box-shadow:none;scrollbar-gutter:stable}
table{font-size:13px;min-width:680px}
caption{text-align:right;padding:9px 12px;font-size:12px;color:var(--muted);background:var(--card)}
thead th{background:#edf1ef;color:#414d47;z-index:2;vertical-align:bottom;white-space:nowrap}
tbody th{padding:10px;text-align:right;border-bottom:1px solid var(--line);font-weight:500}
tbody td{vertical-align:top}
tbody tr:hover{background:#f2f7f4}
.num{direction:ltr;unicode-bidi:isolate;white-space:nowrap;min-width:76px;width:92px}
.sym{direction:ltr;unicode-bidi:isolate;white-space:nowrap;min-width:96px}
.rank{width:40px;min-width:40px}.name{min-width:140px}
.score{width:40px}.delta{display:inline-block;min-width:40px}
.portfolio table{min-width:860px}.portfolio td:last-child{min-width:290px}
.idx-cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.idx-head{align-items:flex-start;flex-wrap:wrap}.idx-head h4{flex:1 1 160px}
.idx-region h3{color:var(--ink)}.idx-row{flex-wrap:wrap}
.idx-rec,.idx-metrics span{background:transparent;border-radius:0;padding-inline:0;color:var(--muted)}
.idx-metrics span{border-inline-end:1px solid var(--line);padding-inline-end:8px}
.pick-main{background:transparent;border:0;border-inline-start:3px solid var(--accent);border-radius:0;padding:4px 16px;box-shadow:none}
.pick-label{background:var(--accent)}.pick-combined,.regime-score,.pick-regime{color:var(--accent)}
.pick-strength,.sell-watchlist{border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;padding:12px 0}
.risk-box{grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr))}
.risk-box div,.regime-metrics div,.score-summary div,.beta-list div{background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:8px 10px;min-width:0}
.risk-box small{overflow-wrap:anywhere}
.sell-card{border-inline-start:3px solid var(--sell);background:#fffafa}
.sell-card.sell-reduce,.sell-card.sell-watch{background:#fcf9f1;border-color:#e5d9bd;border-inline-start-color:var(--hold)}
.sell-card.sell-reduce .sell-level,.sell-card.sell-watch .sell-level{background:var(--hold)}
.detail,.evidence-holding{border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:4px 0;min-width:0}
.empty{background:transparent;border-radius:0}
summary{cursor:pointer;line-height:1.7;padding-block:8px;overflow-wrap:anywhere}
.historical-evidence{min-width:0;padding-block:8px}.historical-evidence h5{font-size:13px;margin:12px 0 4px}
.historical-evidence .note{font-size:12px;margin:6px 0 12px}
.evidence-meta{font-size:13px;color:var(--muted);margin:0 0 6px}
.evidence-table{min-width:1050px}.evidence-table .num{min-width:100px}
.evidence-table th:first-child{min-width:120px}.abstention{color:var(--hold)}
.evidence-warnings{color:var(--hold);font-size:13px}.evidence-dates{font-size:12px}
.evidence-dates ul{max-height:200px;overflow:auto}.index-evidence{border-top:1px solid var(--line);margin-top:12px;font-size:13px}
.ranking-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;font-size:13px}
.ranking-toolbar input{width:260px;max-width:100%;min-height:40px;padding:6px 10px;color:var(--ink);background:var(--card);border:1px solid var(--muted);border-radius:4px}
.ranking-toolbar output{color:var(--muted);font-variant-numeric:tabular-nums;min-width:80px}
.sort-button{background:transparent;border:0;color:inherit;font-weight:600;cursor:pointer;padding:8px 0;min-height:40px;white-space:nowrap}
.sort-button span{display:inline-block;width:12px;color:var(--muted)}
th[aria-sort="ascending"] .sort-button span,th[aria-sort="descending"] .sort-button span{color:var(--accent)}
.fc-head{flex-wrap:wrap}.report-foot{border-top:1px solid var(--line);margin-top:16px}
@media(max-width:640px){.report{padding:16px 12px}.hero h1{font-size:22px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:8px 12px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ranking-toolbar label{width:100%}.ranking-toolbar input{flex:1 1 160px}.card,.idx-card,.fc-card{padding:12px}h2{font-size:18px}}
@media print{
@page{size:A4 landscape;margin:12mm}
body{background:#fff;font-size:10pt}.report{max-width:none;padding:0}
.ranking-toolbar,.sort-button span{display:none}.table-wrap{overflow:visible;max-height:none;border:0;scrollbar-gutter:auto}
table,.portfolio table,.evidence-table{min-width:0;width:100%;font-size:8pt;table-layout:fixed}
thead{display:table-header-group}thead th{position:static;white-space:normal}th,td{padding:5px!important;overflow-wrap:anywhere}
.num,.sym,.rank,.name,.evidence-table .num,.evidence-table th:first-child,.portfolio td:last-child{min-width:0;width:auto;white-space:normal}
.card,.fc-card,.idx-card,.sell-card,tr{break-inside:avoid;box-shadow:none}
.cards,.fc-cards,.idx-cards{display:block}.card,.fc-card,.idx-card{margin-bottom:12px}
.report>section{margin-block:14px;padding-block:0 10px}.hero h1{font-size:20px}
.evidence-dates ul{max-height:none;overflow:visible}a{color:inherit;text-decoration:underline}
}
`;

const INDEX_CSS = `
*{box-sizing:border-box}
body{margin:0;display:flex;min-height:100vh;font-family:"Segoe UI","Assistant",system-ui,Arial,sans-serif;
background:#f1f5f9;color:#1e293b}
.sidebar{width:300px;background:linear-gradient(180deg,#0f172a,#1e293b);color:#e2e8f0;
display:flex;flex-direction:column;padding:24px 18px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.brand .logo{font-size:32px}
.brand h1{margin:0;font-size:20px}.brand p{margin:0;font-size:12px;color:#94a3b8}
.toggle{display:flex;background:rgba(255,255,255,.08);border-radius:12px;padding:4px;margin-bottom:20px}
.toggle button{flex:1;padding:10px;border:none;background:transparent;color:#cbd5e1;
font-size:15px;font-weight:700;border-radius:9px;cursor:pointer;transition:.2s}
.toggle button.active{background:#2563eb;color:#fff;box-shadow:0 4px 12px rgba(37,99,235,.4)}
.run-box{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;padding-bottom:16px;
border-bottom:1px solid rgba(255,255,255,.08)}
.run-btn{padding:11px;border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;
cursor:pointer;transition:.15s}
.run-btn:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.08)}
.run-btn:disabled{opacity:.5;cursor:not-allowed}
.run-daily{background:#16a34a}.run-weekly{background:#2563eb}
.run-status{font-size:12px;line-height:1.5;min-height:14px;color:#cbd5e1}
.run-status code{background:rgba(255,255,255,.12);padding:2px 6px;border-radius:5px;font-size:12px}
.run-status.busy{color:#fbbf24}.run-status.ok{color:#4ade80}.run-status.err{color:#f87171}
.run-status .spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(255,255,255,.3);
border-top-color:#fbbf24;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.report-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
.report-item{display:flex;align-items:center;gap:10px;width:100%;text-align:right;
background:rgba(255,255,255,.04);border:1px solid transparent;color:#e2e8f0;
padding:12px 14px;border-radius:10px;cursor:pointer;font-size:15px;transition:.15s}
.report-item:hover{background:rgba(255,255,255,.1)}
.report-item.selected{background:#2563eb;border-color:#60a5fa}
.report-item .dot{width:8px;height:8px;border-radius:50%;background:#38bdf8;flex-shrink:0}
.report-item .d{flex:1}
.report-item .latest{font-size:11px;background:#16a34a;color:#fff;padding:2px 8px;border-radius:999px}
.no-reports{color:#94a3b8;text-align:center;margin-top:20px;font-size:14px}
.side-foot{color:#64748b;font-size:12px;text-align:center;margin-top:16px}
.viewer{flex:1;position:relative}
.viewer iframe{width:100%;height:100vh;border:none;display:block}
.empty-state{height:100vh;display:flex;flex-direction:column;align-items:center;
justify-content:center;color:#94a3b8;gap:12px}
.empty-state span{font-size:64px}.empty-state p{font-size:18px}
@media(max-width:760px){body{flex-direction:column}.sidebar{width:100%;height:auto;position:static}
.viewer iframe,.empty-state{height:70vh}}
${WORKSPACE_CSS}
.sidebar{width:280px;flex-shrink:0;background:var(--card);color:var(--ink);border-inline-end:1px solid var(--line);padding:24px 18px}
.brand{padding-bottom:18px;border-bottom:2px solid var(--ink);margin-bottom:18px}
.brand h1{font-size:21px;line-height:1.4}.brand p{color:var(--muted)}
.toggle{background:#edf1ef;border-radius:6px;padding:3px;gap:3px}
.toggle button{color:var(--muted);border-radius:4px;min-height:42px;transition:none}
.toggle button.active{background:var(--accent);color:#fff;box-shadow:none}
.run-box{border-bottom-color:var(--line)}
.run-btn{border-radius:4px;min-height:42px;transition:none}.run-btn:hover:not(:disabled){transform:none;filter:none;opacity:.9}
.run-daily{background:var(--accent)}.run-weekly{background:#394540}
.run-status,.no-reports,.side-foot{color:var(--muted)}.run-status code{background:var(--soft)}
.run-status.busy{color:var(--hold)}.run-status.ok{color:var(--buy)}.run-status.err{color:var(--sell)}
.run-status a{color:var(--accent)}.run-status .spin{border-color:var(--line);border-top-color:var(--accent)}
.report-list{min-height:0}.report-item{background:transparent;color:var(--ink);border-radius:4px;min-height:46px;transition:none}
.report-item:hover{background:var(--soft)}.report-item.selected{background:var(--soft);border-color:var(--accent);color:var(--accent)}
.report-item .latest{border-radius:3px;background:var(--accent)}
.viewer{min-width:0;background:var(--bg)}.viewer iframe{height:100dvh}.empty-state{color:var(--muted);height:100dvh}.empty-state p{font-size:16px}
@media(max-width:760px){.sidebar{width:100%;height:auto;padding:16px;border-inline-end:0;border-bottom:1px solid var(--line)}.brand{margin-bottom:12px;padding-bottom:10px}.toggle{margin-bottom:12px}.run-box{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.run-status{grid-column:1/-1}.report-list{max-height:180px}.side-foot{margin-top:10px}.viewer iframe,.empty-state{height:78dvh}}
@media print{body{display:block}.sidebar{display:none}.viewer iframe{height:100vh}.empty-state{height:auto}}
`;
