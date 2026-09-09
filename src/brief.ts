import { holdingSellAlerts, type ReportHtmlInput } from "./html.js";
import type { ReportSummarySnapshot } from "./summary.js";
import { PORTFOLIO } from "./config.js";
import { selectDailyPick, type PickCandidate } from "./pick.js";
import { escapeReportText as escape, narrativeRegion } from "./ai-report.js";

const metric = (value: number | null | undefined): string =>
  value != null && Number.isFinite(value) ? value.toLocaleString("he-IL", { maximumFractionDigits: 2 }) : "לא זמין";
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${metric(value)}`;

export function buildBriefActions(input: ReportHtmlInput): { buy: string[]; sell: string[]; watch: string[]; missing: string[] } {
  const pick = selectDailyPick(input.results, input.horizons, input.regime);
  const alerts = holdingSellAlerts(input.results, input.horizons, input.newsByStock);
  const bySymbol = new Map(input.results.map(result => [result.symbol, result]));
  const sells = new Map(alerts.filter(alert => alert.severity >= 4).map(alert => [alert.symbol, alert]));
  const candidateLine = (candidate: PickCandidate, label: string): string =>
    `${label}: ${candidate.r.name} (${candidate.r.symbol}) · ציון משולב ${metric(candidate.hz.combined)} · סטופ ${metric(candidate.r.risk?.stop)} · יעד ${metric(candidate.r.risk?.target)}`;
  const buy = [
    ...(pick.main && !sells.has(pick.main.r.symbol) ? [candidateLine(pick.main, "מועמדת מובילה")] : []),
    ...(pick.strengthen && !alerts.some(alert => alert.symbol === pick.strengthen?.r.symbol) ? [candidateLine(pick.strengthen, "חיזוק לבדיקה")] : []),
    ...pick.alts.filter(candidate => !sells.has(candidate.r.symbol)).slice(0, 2).map(candidate => candidateLine(candidate, "חלופה")),
  ];
  const sell = [...sells.values()].map(alert => `${alert.name} (${alert.symbol}) · ${alert.severity >= 5 ? "מכירה / יציאה לבדיקה" : "צמצום לבדיקה"} · ${alert.reasons.slice(0, 2).join(" ")} · רמת יציאה ${metric(alert.stop)}`);
  const watch: string[] = [];
  const missing: string[] = [];
  for (const holding of PORTFOLIO) {
    const result = holding.symbol ? bySymbol.get(holding.symbol) : undefined;
    if (!result) {
      missing.push(`${holding.name} (${holding.symbol ?? holding.taseNumber ?? ""}) · ללא כיסוי טכני; אין סיווג קנייה, מכירה או החזקה`);
      continue;
    }
    if (sells.has(result.symbol)) continue;
    const caution = alerts.find(alert => alert.symbol === result.symbol);
    watch.push(`${holding.name} (${result.symbol}) · ${caution ? `${caution.severity >= 3 ? "סטופ הדוק / מעקב" : "מעקב"}: ${caution.reasons.slice(0, 2).join(" ")}` : `החזקה / מעקב · ציון ${metric(result.score)}; ללא התראת יציאה לפי סף המנוע`} · סטופ רצף ${metric(result.sequenceStop)}`);
  }
  return { buy, sell, watch, missing };
}

export function renderPortfolioBrief(input: ReportHtmlInput, snapshot: ReportSummarySnapshot): string {
  const actions = buildBriefActions(input);
  const group = (title: string, entries: string[], empty: string, tone: string): string =>
    `<div class="brief-action ${tone}"><h3>${title}</h3>${entries.length ? `<ul>${entries.map(entry => `<li>${escape(entry)}</li>`).join("")}</ul>` : `<p class="note">${empty}</p>`}</div>`;
  const holdings = snapshot.portfolio.map(holding => {
    const units = holding.symbol && !holding.symbol.endsWith(".TA") ? "דולר" : "אגורות";
    const cell = (label: string, value: string, tone = ""): string => `<div><dt>${label}</dt><dd class="${tone}"><bdi>${escape(value)}</bdi></dd></div>`;
    return `<li class="brief-holding"><div class="brief-holding-name"><strong>${escape(holding.name)}</strong><bdi>${escape(holding.symbol ?? holding.taseNumber ?? "")}</bdi></div>
      <dl>${cell(`מחיר · ${units}`, metric(holding.price))}${cell("רווח / הפסד", holding.returnPct == null ? "לא זמין" : `${signed(holding.returnPct)}%`, holding.returnPct == null ? "" : holding.returnPct >= 0 ? "brief-positive" : "brief-negative")}
      ${cell("ציון", metric(holding.score))}${cell("שינוי ציון", holding.scoreDelta == null ? "לא זמין" : signed(holding.scoreDelta))}
      ${cell("סטופ רצף", metric(holding.sequenceStop))}${cell("סטופ סיכון", metric(holding.stop))}</dl>
      ${holding.coverage !== "analyzed" ? `<p class="brief-coverage">${holding.coverage === "missing" ? "מחיר חסר" : "מחיר בלבד"} · ללא כיסוי טכני</p>` : ""}</li>`;
  }).join("");
  return `<section id="portfolio-brief" class="executive portfolio-brief" aria-labelledby="brief-title">
    <div class="section-heading"><h2 id="brief-title">התיק שלי · סיכום החלטות</h2><span class="brief-source">למועד הדוח</span></div>
    ${narrativeRegion()}
    <h3 class="brief-subtitle">מצב ההחזקות</h3><ul class="brief-holdings">${holdings || '<li class="note">אין החזקות בתיק.</li>'}</ul>
    <div class="brief-actions">${group("קנייה / חיזוק", actions.buy, "אין מועמדת שעברה את מסנני הבחירה עם הנתונים הזמינים.", "brief-buy")}
    ${group("מכירה / צמצום", actions.sell, "אין התראת יציאה או צמצום לפי סף המנוע בהחזקות שנותחו; אין בכך אישור להיעדר סיכון.", "brief-sell")}
    ${group("החזקה / מעקב", actions.watch, "אין החזקות שנותחו בקבוצה זו.", "brief-watch")}</div>
    ${actions.missing.length ? `<div class="brief-missing"><h3>ללא כיסוי טכני</h3><p>${actions.missing.map(escape).join("<br>")}</p></div>` : ""}
    <p class="note">סיווגי מעקב לפי כללי הדוח, לא הוראות מסחר. רווח/הפסד ביחס למחיר הכניסה, ללא כמויות, עמלות או דיבידנדים. המחירים אינם בזמן אמת.</p>
  </section>`;
}

export const BRIEF_CSS = `
.portfolio-brief{--brief-green:#146848;--brief-red:#ac303e;--brief-blue:#265e87;background:transparent;min-width:0;letter-spacing:0}
.portfolio-brief h3{font-size:16px;line-height:1.5;letter-spacing:0;margin:0 0 8px}
.brief-source{font-size:12px;color:var(--muted,#626870);white-space:normal}
.brief-ai{border-block:1px solid var(--line,#d9dedc);padding:16px 0;margin-bottom:20px;background:linear-gradient(115deg,rgba(20,104,72,.04),transparent 65%)}
.brief-ai-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brief-ai-text{white-space:pre-wrap;font-size:15px;line-height:1.85;margin:6px 0 10px;overflow-wrap:anywhere}
.brief-holdings{list-style:none;margin:0 0 22px;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}
.brief-holding{padding:14px 0;border-bottom:1px solid var(--line,#d9dedc);min-width:0;overflow-wrap:anywhere}
.brief-holding-name{display:flex;gap:8px;justify-content:space-between;align-items:baseline;font-size:14px}.brief-holding-name bdi{font-size:12px;color:var(--muted,#626870)}
.brief-holding dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:10px 0 0}.brief-holding dl>div{min-width:0}
.brief-holding dt{font-size:11px;color:var(--muted,#626870);margin-bottom:4px}.brief-holding dd{font-size:14px;font-weight:600;margin:0;font-variant-numeric:tabular-nums}
.brief-positive{color:var(--brief-green)}.brief-negative{color:var(--brief-red)}.brief-coverage{font-size:12px;margin:8px 0 0;color:var(--muted,#626870)}
.brief-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.brief-action{border-top:3px solid var(--brief-blue);padding-top:12px;min-width:0}
.brief-buy{border-color:var(--brief-green)}.brief-sell{border-color:var(--brief-red)}.brief-action ul{list-style:none;padding:0;margin:0}.brief-action li{font-size:13px;line-height:1.8;padding:8px 0;border-bottom:1px solid var(--line,#d9dedc);overflow-wrap:anywhere}
.brief-missing{margin-top:20px;border-inline-start:3px solid #ad781c;padding-inline-start:14px}.brief-missing p{font-size:13px;line-height:1.8;overflow-wrap:anywhere}
@media(max-width:760px){.brief-holdings,.brief-actions{grid-template-columns:minmax(0,1fr)}.brief-actions{gap:20px}.brief-holding dl{grid-template-columns:repeat(2,minmax(0,1fr))}.brief-ai-text{font-size:14px}.brief-holding-name{flex-wrap:wrap}.portfolio-brief .section-heading{flex-wrap:wrap;gap:8px}}
@media print{.brief-holding,.brief-action{break-inside:avoid}.brief-ai{background:none}.brief-actions{grid-template-columns:minmax(0,1fr)}}
`;