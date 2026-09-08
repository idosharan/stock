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

test("mobile viewer accepts height only from the selected report and restores desktop sizing", () => {
  const source = readFileSync(new URL("../report-view.js", import.meta.url), "utf8");
  const listeners = new Map<string, (event?: any) => void>();
  const frame = {
    src: "https://example.test/stock/reports/report-daily-2026-09-06.html",
    contentWindow: {}, contentDocument: null,
    style: { height: "" }, dataset: {} as Record<string, string>,
    addEventListener: () => undefined
  };
  const mobile = {
    matches: true,
    addEventListener: (_name: string, handler: () => void) => listeners.set("viewport", handler)
  };
  new Script(source).runInNewContext({
    document: { querySelector: () => null, getElementById: () => frame },
    matchMedia: () => mobile, location: { origin: "https://example.test" },
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler)
  });
  const receive = listeners.get("message")!;
  const valid = {
    source: frame.contentWindow, origin: "https://example.test",
    data: { type: "tase-report-height", url: frame.src, height: 3456 }
  };
  receive({ ...valid, source: {} });
  receive({ ...valid, origin: "https://untrusted.test" });
  receive({ ...valid, data: { ...valid.data, url: "https://example.test/old.html" } });
  for (const height of [0, -1, NaN, Infinity, 1000001, "3456"]) {
    receive({ ...valid, data: { ...valid.data, height } });
  }
  assert.equal(frame.style.height, "");
  receive(valid);
  assert.equal(frame.style.height, "3456px");
  assert.equal(frame.dataset.reportHeight, "3456");
  receive({ ...valid, data: { ...valid.data, height: 1200 } });
  assert.equal(frame.style.height, "1200px");
  mobile.matches = false;
  listeners.get("viewport")!();
  assert.equal(frame.style.height, "");
  mobile.matches = true;
  listeners.get("viewport")!();
  assert.equal(frame.style.height, "1200px");
});

test("local HTML viewer accepts opaque file origins only from its selected report", () => {
  const source = readFileSync(new URL("../report-view.js", import.meta.url), "utf8");
  let receive: (event: any) => void = () => undefined;
  const frame = {
    src: "file:///U:/stock/reports/report-daily-2026-09-06.html", contentWindow: {},
    contentDocument: null, style: { height: "" }, dataset: {}, addEventListener: () => undefined
  };
  new Script(source).runInNewContext({
    document: { querySelector: () => null, getElementById: () => frame },
    matchMedia: () => ({ matches: true, addEventListener: () => undefined }),
    location: { protocol: "file:", origin: "file://" },
    addEventListener: (name: string, handler: (event: any) => void) => { if (name === "message") receive = handler; }
  });
  const event = { source: frame.contentWindow, origin: "null",
    data: { type: "tase-report-height", url: frame.src, height: 2400 } };
  receive({ ...event, source: {} });
  receive({ ...event, data: { ...event.data, url: "file:///U:/other.html" } });
  assert.equal(frame.style.height, "");
  receive(event);
  assert.equal(frame.style.height, "2400px");
});