/**
 * נקודת הכניסה של האייג'נט.
 * הרצה:
 *   npm run daily    -> דוח יומי
 *   npm run weekly   -> דוח שבועי
 *
 * בכל הרצה: מושך נתוני מניות עדכניים מ-Yahoo Finance, גורד כתבות חדשות
 * מהעיתונות הכלכלית הישראלית, מבצע ניתוח טכני ומפיק דוח Markdown בתיקיית reports/.
 */
import { ALLOW_INSECURE_TLS } from "./config.js";

// עקיפת אימות TLS לסביבות עם פרוקסי ארגוני (חייב לקרות לפני בקשות רשת).
if (ALLOW_INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { runAnalysis } from "./runner.js";
import type { Mode } from "./report.js";

function parseMode(): Mode {
  const arg = process.argv.find((a) => a.startsWith("--mode="));
  const val = arg?.split("=")[1];
  return val === "weekly" ? "weekly" : "daily";
}

async function main() {
  const mode = parseMode();
  const { results } = await runAnalysis(mode);

  const top = [...results].sort((a, b) => b.score - a.score).slice(0, 5);
  console.log("\n🏆 5 המובילות:");
  top.forEach((r, i) =>
    console.log(`   ${i + 1}. ${r.name} — ${r.recommendation} (ציון ${r.score})`)
  );
}

main().catch((err) => {
  console.error("שגיאה קריטית:", err);
  process.exit(1);
});
