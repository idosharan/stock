import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { buildIndexHtml, renderReportHtml } from "../src/html.js";

test("new reports load their compact presentation from the project asset path", () => {
  const html = renderReportHtml({ mode: "daily", results: [], indices: [], newsByStock: new Map(),
    generatedAt: new Date("2026-09-07T12:00:00Z"),
    forecast: { horizon: "היום", summary: "סקירה", markets: [],
      newsTone: { positive: 0, negative: 0, neutral: 0, label: "ניטרלי" } } });
  assert.match(html, /<script src="\.\.\/report-view\.js" defer><\/script>/);
  assert.match(buildIndexHtml([]), /<script src="\.\/report-view\.js" defer><\/script>/);
});

test("compact report enhancement safely ignores documents without a report or viewer", () => {
  const source = readFileSync(new URL("../report-view.js", import.meta.url), "utf8");
  new Script(source).runInNewContext({ document: { querySelector: () => null, getElementById: () => null } });
});