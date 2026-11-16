/**
 * בחירת ההמלצה היומית — מסננת איכות (נזילות, ציון משולב, יחס סיכוי/סיכון),
 * מסנן מצב שוק, מסנן דוחות כספיים וכללי מיכה סטוקס (דוח בתוך 7 ימים, חוק 3 הימים,
 * ממוצע 150, לא רודפים). משותפת לדוח ה-HTML ולמעקב ביצועי ההמלצות.
 */
import { PORTFOLIO, RISK } from "./config.js";
import type { AnalysisResult, HorizonInfo } from "./analysis.js";
import type { MarketRegime } from "./regime.js";

export interface PickCandidate {
  r: AnalysisResult;
  hz: HorizonInfo;
}

export interface RejectedCandidate {
  name: string;
  symbol: string;
  reason: string;
}

export interface PickSelection {
  main: PickCandidate | null;
  alts: PickCandidate[];
  strengthen: PickCandidate | null;
  /** סף הציון המשולב שהופעל בפועל (מוחמר במצב ריסק-אוף). */
  threshold: number;
  regimeNote: string | null;
  /** מועמדות שנפסלו על סף איכות — שקיפות למה לא נבחרו. */
  rejected: RejectedCandidate[];
}

const BASE_THRESHOLD = 30;
const RISK_OFF_THRESHOLD = 45;
/** Prefix of a rejection that comes from the followed creator's rules. */
export const METHOD_REJECT_PREFIX = "כללי מיכה סטוקס: ";

export function selectDailyPick(
  results: AnalysisResult[],
  horizons: Map<string, HorizonInfo> | undefined,
  regime?: MarketRegime | null
): PickSelection {
  const empty: PickSelection = {
    main: null,
    alts: [],
    strengthen: null,
    threshold: BASE_THRESHOLD,
    regimeNote: null,
    rejected: [],
  };
  if (!horizons || horizons.size === 0) return empty;

  const riskOff = regime?.label === "ריסק-אוף";
  const threshold = riskOff ? RISK_OFF_THRESHOLD : BASE_THRESHOLD;
  const baseNote = riskOff
    ? `מצב שוק ריסק-אוף (${regime?.score}) — סף הקנייה הועלה ל-${threshold} והעדיפות להמתנה.`
    : regime?.label === "ריסק-און"
    ? `מצב שוק ריסק-און (${regime?.score}) — רוח גבית לפריצות.`
    : null;
  const macroNote = regime?.macroFlags?.length
    ? `דגלי מאקרו: ${regime.macroFlags.map((f) => f.label).join(" · ")}.`
    : null;
  const regimeNote = [baseNote, macroNote].filter(Boolean).join(" ") || null;

  const held = new Set(PORTFOLIO.map((h) => h.symbol).filter((s): s is string => !!s));
  const rejected: RejectedCandidate[] = [];
  const rankOf = (hz: HorizonInfo): number => hz.ranking ?? hz.combined;

  const cands = results
    .map((r) => ({ r, hz: horizons.get(r.symbol) }))
    .filter((x): x is PickCandidate => !!x.hz)
    .filter((x) => {
      if (!x.r.liquidityNote.includes("גבוהה")) return false;
      if (x.hz.stale) {
        rejected.push({ name: x.r.name, symbol: x.r.symbol, reason: "נר יומי חסר או מפגר אחרי המדד — נתון לא עדכני" });
        return false;
      }
      if (x.hz.grades?.redFlags.length) {
        rejected.push({ name: x.r.name, symbol: x.r.symbol, reason: `דגל אדום: ${x.hz.grades.redFlags.join("; ")}` });
        return false;
      }
      const failing = (["momentum", "revisions"] as const).filter((k) => x.hz.grades?.letters[k] === "F");
      if (failing.length) {
        const names = failing.map((k) => (k === "momentum" ? "מומנטום F" : "רוויזיות F")).join(" ו-");
        rejected.push({ name: x.r.name, symbol: x.r.symbol, reason: `${names} — כלל Seeking Alpha: אין קנייה עם מומנטום או תחזיות רווח חלשות` });
        return false;
      }
      if (x.hz.engine === "hybrid") {
        if (x.r.recommendation !== "קנייה" && x.r.recommendation !== "קנייה חזקה") return false;
        if (x.hz.waitForConfirmation) {
          rejected.push({ name: x.r.name, symbol: x.r.symbol, reason: "אות מכירה טכני טרי — להמתין לאישור" });
          return false;
        }
      } else if (x.r.score < 15 || x.hz.combined < threshold) {
        return false;
      }
      if (!x.r.risk) {
        rejected.push({ name: x.r.name, symbol: x.r.symbol, reason: "לא ניתן לגזור סטופ הגיוני" });
        return false;
      }
      if (x.r.risk.rr < RISK.minRR) {
        rejected.push({
          name: x.r.name,
          symbol: x.r.symbol,
          reason: `יחס סיכוי/סיכון ${x.r.risk.rr.toFixed(1)} נמוך מהמינימום (${RISK.minRR})`,
        });
        return false;
      }
      if (x.r.earningsInDays != null && x.r.earningsInDays <= 2) {
        rejected.push({
          name: x.r.name,
          symbol: x.r.symbol,
          reason: `דוחות כספיים בעוד ${x.r.earningsInDays} ימים`,
        });
        return false;
      }
      if (x.hz.method?.blocks.length) {
        rejected.push({ name: x.r.name, symbol: x.r.symbol, reason: `${METHOD_REJECT_PREFIX}${x.hz.method.blocks.join("; ")}` });
        return false;
      }
      return true;
    })
    .sort((a, b) => rankOf(b.hz) - rankOf(a.hz) || b.hz.combined - a.hz.combined);

  const fresh = cands.filter((x) => !held.has(x.r.symbol));
  // With more rules more candidates fall out — show the highest-ranked ones, not the first in watchlist order
  const rankOfSymbol = (symbol: string): number => {
    const h = horizons.get(symbol);
    return h ? rankOf(h) : -Infinity;
  };
  return {
    main: fresh[0] ?? null,
    alts: fresh.slice(1, 3),
    strengthen: cands.find((x) => held.has(x.r.symbol)) ?? null,
    threshold,
    regimeNote,
    rejected: rejected.sort((a, b) => rankOfSymbol(b.symbol) - rankOfSymbol(a.symbol)).slice(0, 5),
  };
}
