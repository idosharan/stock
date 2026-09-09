export const AI_START = "<!-- report-ai:start -->";
export const AI_END = "<!-- report-ai:end -->";

export interface ReportReceipt {
  version: 1;
  mode: "daily" | "weekly";
  generatedAt: string;
  fileName: string;
  digestHash: string;
  htmlHash: string;
}

export function escapeReportText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function narrativeRegion(text?: string): string {
  const body = text?.replace(/^AI narrative \([^\n]*\)\s*\n?/, "").trim();
  return `${AI_START}<div id="ai-report-narrative" class="brief-ai" aria-label="פרשנות Gemini">
    <div class="brief-ai-heading"><h3>השורה התחתונה</h3><span class="brief-source">${body ? "Gemini · פרשנות AI" : "סיכום מבוסס נתוני הדוח"}</span></div>
    ${body ? `<p class="brief-ai-text">${escapeReportText(body)}</p><p class="note">פרשנות AI לא מאומתת; נתוני הדוח וכללי המנוע הם המקור. לא ייעוץ השקעות.</p>`
      : '<p class="note">פרשנות Gemini אינה זמינה בדוח זה. מצב התיק והאותות המבוססים על נתוני הדוח מופיעים להלן.</p>'}
  </div>${AI_END}`;
}

export function setReportNarrative(html: string, text?: string): string {
  const start = html.indexOf(AI_START);
  const end = html.indexOf(AI_END);
  if (start < 0 || end < start || html.indexOf(AI_START, start + AI_START.length) !== -1
    || html.indexOf(AI_END, end + AI_END.length) !== -1) throw new Error("Invalid report AI region");
  return html.slice(0, start) + narrativeRegion(text) + html.slice(end + AI_END.length);
}