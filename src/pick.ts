/**
 * בחירת ההמלצה היומית — מסננת איכות (נזילות, ציון משולב, יחס סיכוי/סיכון),
 * מסנן מצב שוק ומסנן דוחות כספיים. משותפת לדוח ה-HTML ולמעקב ביצועי ההמלצות.
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
  const regimeNote = riskOff
    ? `מצב שוק ריסק-אוף (${regime?.score}) — סף הקנייה הועלה ל-${threshold} והעדיפות להמתנה.`
    : regime?.label === "ריסק-און"
    ? `מצב שוק ריסק-און (${regime?.score}) — רוח גבית לפריצות.`
    : null;

  const held = new Set(PORTFOLIO.map((h) => h.symbol).filter((s): s is string => !!s));
  const rejected: RejectedCandidate[] = [];

  const cands = results
    .map((r) => ({ r, hz: horizons.get(r.symbol) }))
    .filter((x): x is PickCandidate => !!x.hz)
    .filter((x) => {
      if (!x.r.liquidityNote.includes("גבוהה")) return false;
      if (x.r.score < 15 || x.hz.combined < threshold) return false;
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
      return true;
    })
    .sort((a, b) => b.hz.combined - a.hz.combined);

  const fresh = cands.filter((x) => !held.has(x.r.symbol));
  return {
    main: fresh[0] ?? null,
    alts: fresh.slice(1, 3),
    strengthen: cands.find((x) => held.has(x.r.symbol)) ?? null,
    threshold,
    regimeNote,
    rejected: rejected.slice(0, 5),
  };
}
