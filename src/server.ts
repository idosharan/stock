/**
 * שרת Web פשוט: מגיש דף HTML עם כפתורים להרצת הניתוח (יומי/שבועי),
 * הצגת תוצאות בטבלה, וצפייה/הורדה של הדוח. אין תלות בספריות חיצוניות (http מובנה).
 *
 * הרצה: npm run web   ואז פתיחת http://localhost:3000
 */
import { ALLOW_INSECURE_TLS } from "./config.js";

if (ALLOW_INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runAnalysis } from "./runner.js";
import type { Mode } from "./report.js";
import type { AnalysisResult } from "./analysis.js";
import type { StockNews } from "./news.js";

const PORT = Number(process.env.PORT ?? 3000);
const staticAssets = new Map<string, { file: string; type: string; cache: string }>([
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=3600" }],
  ["/report-view.js", { file: "report-view.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=3600" }],
  ["/service-worker.js", { file: "service-worker.js", type: "text/javascript; charset=utf-8", cache: "no-store" }],
  ["/manifest.webmanifest", { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8", cache: "public, max-age=3600" }],
  ["/assets/icon-192.png", { file: "assets/icon-192.png", type: "image/png", cache: "public, max-age=3600" }],
  ["/assets/icon-512.png", { file: "assets/icon-512.png", type: "image/png", cache: "public, max-age=3600" }],
]);

// מונע הרצות במקביל (Yahoo מגביל קצב).
let running = false;

interface ApiResponse {
  ok: boolean;
  mode: Mode;
  generatedAt: string;
  newsCount: number;
  reportFile: string;
  results: Array<{
    symbol: string;
    name: string;
    price: number;
    score: number;
    recommendation: string;
    rsi: number | null;
    percentB: number | null;
    macdHist: number | null;
    trendUp: boolean;
    newsSentiment: number;
    signals: string[];
    news: Array<{ title: string; link?: string; source: string }>;
  }>;
}

function toApi(
  mode: Mode,
  generatedAt: Date,
  newsCount: number,
  reportFile: string,
  results: AnalysisResult[],
  newsByStock: Map<string, StockNews>
): ApiResponse {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  return {
    ok: true,
    mode,
    generatedAt: generatedAt.toLocaleString("he-IL"),
    newsCount,
    reportFile,
    results: sorted.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      price: r.price,
      score: r.score,
      recommendation: r.recommendation,
      rsi: r.indicators.rsi,
      percentB: r.indicators.percentB,
      macdHist: r.indicators.macdHist,
      trendUp: r.indicators.trendUp,
      newsSentiment: r.newsSentiment,
      signals: r.signals,
      news: (newsByStock.get(r.symbol)?.items ?? []).slice(0, 5).map((n) => ({
        title: n.title,
        link: n.link,
        source: n.source,
      })),
    })),
  };
}

async function serveStaticAsset(pathname: string, method: string | undefined, res: import("node:http").ServerResponse): Promise<boolean> {
  const asset = staticAssets.get(pathname);
  if (!asset) return false;
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  try {
    const content = await readFile(asset.file);
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": asset.cache });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (await serveStaticAsset(url.pathname, req.method, res)) return;

  // עמוד הבית — מגיש את לוח הבקרה (index.html) שנבנה עם כפתורי ההרצה.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const dash = await readFile("index.html", "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(dash);
    } catch {
      // אם עדיין לא הופק דוח כלשהו, אין index.html — מציגים דף ברירת מחדל.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(HTML_PAGE);
    }
    return;
  }

  // הרצת ניתוח
  if (url.pathname === "/api/run") {
    // POST בלבד — מונע הפעלה מרחוק דרך תמונה/לינק בדפדפן (CSRF)
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "יש להשתמש ב-POST." }));
      return;
    }
    if (running) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "ניתוח כבר רץ כעת. נא להמתין לסיומו." }));
      return;
    }
    const modeParam = url.searchParams.get("mode");
    const mode: Mode = modeParam === "weekly" ? "weekly" : "daily";
    running = true;
    try {
      const run = await runAnalysis(mode);
      const payload = toApi(
        mode,
        run.generatedAt,
        run.newsCount,
        run.reportPath.split(/[\\/]/).pop() ?? "",
        run.results,
        run.newsByStock
      );
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    } finally {
      running = false;
    }
    return;
  }

  // הגשת קובץ דוח (HTML או Markdown)
  if (url.pathname.startsWith("/reports/")) {
    const name = url.pathname.replace("/reports/", "");
    // הגנה מפני path traversal
    if (!/^report-(daily|weekly)-\d{4}-\d{2}-\d{2}\.(html|md)$/.test(name)) {
      res.writeHead(400);
      res.end("שם קובץ לא חוקי");
      return;
    }
    const isHtml = name.endsWith(".html");
    try {
      const content = await readFile(`reports/${name}`, "utf8");
      res.writeHead(200, {
        "Content-Type": isHtml
          ? "text/html; charset=utf-8"
          : "text/markdown; charset=utf-8",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("הדוח לא נמצא");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n🌐 השרת פעיל: http://localhost:${PORT}\n   פתח/י את הכתובת בדפדפן ולחץ/י על הכפתורים.`);
});

/* ----------------------------- דף ה-HTML ----------------------------- */

const HTML_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>אייג'נט ניתוח טכני — בורסת ת"א</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --accent:#22c55e; --accent2:#3b82f6;
          --text:#e2e8f0; --muted:#94a3b8; --danger:#ef4444; --warn:#eab308; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Segoe UI", Arial, sans-serif; background:var(--bg);
         color:var(--text); padding:24px; }
  h1 { margin:0 0 4px; font-size:26px; }
  .sub { color:var(--muted); margin-bottom:20px; font-size:14px; }
  .controls { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; align-items:center; }
  button { cursor:pointer; border:none; border-radius:10px; padding:12px 22px;
           font-size:16px; font-weight:600; color:#fff; transition:.15s transform, .15s opacity; }
  button:hover { transform: translateY(-2px); }
  button:disabled { opacity:.5; cursor:not-allowed; transform:none; }
  .btn-daily { background:var(--accent); }
  .btn-weekly { background:var(--accent2); }
  .btn-report { background:#64748b; }
  .status { color:var(--muted); font-size:14px; min-height:20px; }
  .spinner { display:inline-block; width:16px; height:16px; border:3px solid #475569;
             border-top-color:var(--accent); border-radius:50%; animation:spin 1s linear infinite;
             vertical-align:middle; margin-left:8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:12px; margin-bottom:20px; }
  .kpi { background:var(--card); border-radius:12px; padding:14px; text-align:center; }
  .kpi .v { font-size:24px; font-weight:700; }
  .kpi .l { color:var(--muted); font-size:12px; margin-top:4px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:12px; overflow:hidden; }
  th, td { padding:10px 12px; text-align:right; border-bottom:1px solid #334155; font-size:14px; }
  th { background:#0b1220; color:var(--muted); position:sticky; top:0; }
  tr:hover { background:#243044; }
  .rec { padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; white-space:nowrap; }
  .rec-strong { background:#064e3b; color:#34d399; }
  .rec-buy { background:#14532d; color:#4ade80; }
  .rec-hold { background:#422006; color:#fbbf24; }
  .rec-avoid { background:#450a0a; color:#f87171; }
  .score-bar { height:6px; border-radius:3px; background:#334155; overflow:hidden; }
  .score-bar > span { display:block; height:100%; }
  details { margin-top:4px; }
  summary { cursor:pointer; color:var(--accent2); font-size:13px; }
  .signals { margin:6px 0 0; padding-in-start:18px; color:var(--muted); font-size:13px; }
  .signals li { margin:2px 0; }
  .news a { color:#60a5fa; text-decoration:none; }
  .news a:hover { text-decoration:underline; }
  .disclaimer { margin-top:24px; color:var(--muted); font-size:12px; border-top:1px solid #334155; padding-top:12px; }
</style>
</head>
<body>
  <h1>📈 אייג'נט ניתוח טכני — בורסת ת"א</h1>
  <div class="sub">ניתוח רצועות בולינגר, נרות יפניים, RSI, MACD, נזילות וסנטימנט חדשות — בלחיצת כפתור.</div>

  <div class="controls">
    <button class="btn-daily" id="btnDaily" onclick="run('daily')">▶️ הרץ ניתוח יומי</button>
    <button class="btn-weekly" id="btnWeekly" onclick="run('weekly')">📅 הרץ ניתוח שבועי</button>
    <button class="btn-report" id="btnReport" onclick="openReport()" disabled>📄 פתח דוח Markdown</button>
    <span class="status" id="status"></span>
  </div>

  <div class="cards" id="kpis" style="display:none">
    <div class="kpi"><div class="v" id="kTotal">0</div><div class="l">מניות שנותחו</div></div>
    <div class="kpi"><div class="v" id="kBuy">0</div><div class="l">המלצות קנייה</div></div>
    <div class="kpi"><div class="v" id="kNews">0</div><div class="l">כתבות שנסרקו</div></div>
    <div class="kpi"><div class="v" id="kTime">-</div><div class="l">עודכן</div></div>
  </div>

  <div id="tableWrap"></div>

  <div class="disclaimer">
    ⚠️ הכלי מבצע ניתוח טכני אוטומטי בלבד ואינו מהווה ייעוץ השקעות. השקעה בניירות ערך כרוכה בסיכון.
    יש להתייעץ עם יועץ מורשה לפני קבלת החלטות.
  </div>

<script>
let lastReportFile = null;

function recClass(r){
  if(r==='קנייה חזקה') return 'rec-strong';
  if(r==='קנייה') return 'rec-buy';
  if(r==='החזקה') return 'rec-hold';
  return 'rec-avoid';
}
function scoreColor(s){
  if(s>=45) return '#22c55e'; if(s>=25) return '#84cc16';
  if(s>=0) return '#eab308'; return '#ef4444';
}
function esc(t){ return (t||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function setRunning(on, msg){
  document.getElementById('btnDaily').disabled = on;
  document.getElementById('btnWeekly').disabled = on;
  document.getElementById('status').innerHTML = msg + (on ? '<span class="spinner"></span>' : '');
}

async function run(mode){
  setRunning(true, 'מריץ ניתוח ' + (mode==='daily'?'יומי':'שבועי') + '... זה עשוי לקחת דקה');
  try {
    const res = await fetch('/api/run?mode=' + mode, { method: 'POST' });
    const data = await res.json();
    if(!data.ok){ throw new Error(data.error || 'שגיאה'); }
    render(data);
    setRunning(false, '✅ הושלם בהצלחה — ' + data.results.length + ' מניות.');
  } catch(e){
    setRunning(false, '❌ ' + e.message);
  }
}

function openReport(){
  if(lastReportFile) window.open('/reports/' + lastReportFile, '_blank');
}

function render(data){
  lastReportFile = data.reportFile;
  document.getElementById('btnReport').disabled = false;

  const buys = data.results.filter(r=>r.recommendation==='קנייה'||r.recommendation==='קנייה חזקה');
  document.getElementById('kpis').style.display = 'grid';
  document.getElementById('kTotal').textContent = data.results.length;
  document.getElementById('kBuy').textContent = buys.length;
  document.getElementById('kNews').textContent = data.newsCount;
  document.getElementById('kTime').textContent = data.generatedAt.split(',')[0] || data.generatedAt;

  let rows = data.results.map((r,i)=>{
    const pb = r.percentB!=null ? Math.round(r.percentB*100)+'%' : '-';
    const newsItems = r.news.map(n=> (n.link && /^https?:\\/\\//i.test(n.link))
        ? '<li><a href="'+esc(n.link)+'" target="_blank" rel="noopener noreferrer">'+esc(n.title)+'</a> <small>('+esc(n.source)+')</small></li>'
        : '<li>'+esc(n.title)+'</li>').join('');
    const signals = r.signals.map(s=>'<li>'+esc(s)+'</li>').join('');
    return '<tr>'+
      '<td>'+(i+1)+'</td>'+
      '<td><b>'+esc(r.name)+'</b><br><small style="color:#94a3b8">'+esc(r.symbol)+'</small></td>'+
      '<td>'+r.price.toFixed(2)+'</td>'+
      '<td><div class="score-bar"><span style="width:'+Math.max(0,(r.score+100)/2)+'%;background:'+scoreColor(r.score)+'"></span></div>'+r.score+'</td>'+
      '<td><span class="rec '+recClass(r.recommendation)+'">'+esc(r.recommendation)+'</span></td>'+
      '<td>'+(r.rsi!=null?Math.round(r.rsi):'-')+'</td>'+
      '<td>'+pb+'</td>'+
      '<td>'+(r.trendUp?'⬆️':'⬇️')+'</td>'+
      '<td>'+(r.newsSentiment>0?'➕':r.newsSentiment<0?'➖':'•')+'</td>'+
      '<td><details><summary>פירוט</summary><ul class="signals">'+signals+'</ul>'+
        (newsItems?'<ul class="signals news">'+newsItems+'</ul>':'')+'</details></td>'+
      '</tr>';
  }).join('');

  document.getElementById('tableWrap').innerHTML =
    '<table><thead><tr>'+
    '<th>#</th><th>מניה</th><th>מחיר</th><th>ציון</th><th>המלצה</th>'+
    '<th>RSI</th><th>%B</th><th>מגמה</th><th>חדשות</th><th>פירוט</th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table>';
}
</script>
</body>
</html>`;
