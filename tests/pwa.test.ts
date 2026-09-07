import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";

function createNode() {
  let open = false;
  const listeners = new Map<string, Array<(event?: any) => void>>();
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    href: "",
    returnValue: "",
    open,
    dataset: {},
    style: {},
    focusCount: 0,
    showModalCount: 0,
    closeCount: 0,
    addEventListener(type: string, listener: (event?: any) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    dispatch(type: string, event: any = {}) {
      return Promise.all((listeners.get(type) ?? []).map(listener => listener(event)));
    },
    focus() {
      this.focusCount += 1;
    },
    showModal() {
      open = true;
      this.open = true;
      this.showModalCount += 1;
    },
    close(value = "") {
      open = false;
      this.open = false;
      this.returnValue = value;
      this.closeCount += 1;
      this.dispatch("close", { target: this });
    },
  };
}

function appHarness(options: {
  url?: string;
  secure?: boolean;
  standalone?: boolean;
  registerReject?: boolean;
  scope?: string;
  managerHref?: string;
} = {}) {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const installButton = createNode();
  const openHelpButton = createNode();
  const closeHelpButton = createNode();
  const helpDialog = createNode();
  const helpManagement = createNode();
  const appStatus = createNode();
  const manageReports = createNode();
  manageReports.href = options.managerHref ?? "https://github.com/analyst/market-reports/actions/workflows/reports.yml";
  const listeners = new Map<string, Array<(event?: any) => void>>();
  const registrations: string[] = [];
  const matchMediaCalls: string[] = [];
  const context = {
    console,
    URL,
    location: new URL(options.url ?? "https://analyst.github.io/stock/index.html"),
    window: null as any,
    document: {
      baseURI: options.url ?? "https://analyst.github.io/stock/index.html",
      getElementById(id: string) {
        return new Map([
          ["install-app", installButton],
          ["open-app-help", openHelpButton],
          ["close-app-help", closeHelpButton],
          ["app-help", helpDialog],
          ["help-management", helpManagement],
          ["app-status", appStatus],
          ["manage-reports", manageReports],
        ]).get(id);
      },
      querySelector() {
        return null;
      },
    },
    navigator: {
      standalone: options.standalone ?? false,
      serviceWorker: {
        register: (url: string, registrationOptions: { scope: string }) => {
          registrations.push(`${url}|${registrationOptions.scope}`);
          if (options.registerReject) return Promise.reject(new Error("registration failed"));
          return Promise.resolve({ scope: registrationOptions.scope });
        },
      },
    },
    matchMedia: (query: string) => {
      matchMediaCalls.push(query);
      return { matches: options.standalone ?? false };
    },
    isSecureContext: options.secure ?? true,
    addEventListener(type: string, listener: (event?: any) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    dispatch(type: string, event: any = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  context.window = context;
  new Script(source).runInNewContext(context);
  return { context, installButton, openHelpButton, closeHelpButton, helpDialog, helpManagement, appStatus, manageReports, registrations, matchMediaCalls };
}

function workerHarness(scope = "https://analyst.github.io/stock/") {
  const source = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const listeners = new Map<string, Array<(event: any) => void>>();
  const fetchCalls: Array<{ url: string; cache: string | undefined }> = [];
  const context = {
    URL,
    location: new URL(scope),
    registration: { scope },
    clients: { claim: () => Promise.resolve() },
    Response: class {
      body: string;
      status: number;
      headers: Map<string, string>;
      constructor(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.headers = new Map(Object.entries(init.headers ?? {}));
      }
      text() {
        return Promise.resolve(this.body);
      }
    },
    fetch: (request: string | { url: string; cache?: string }, options?: { cache?: string }) => {
      const url = typeof request === "string" ? request : request.url;
      const cache = typeof request === "string" ? options?.cache : request.cache;
      fetchCalls.push({ url, cache });
      if (url.includes("offline")) return Promise.reject(new Error("offline"));
      return Promise.resolve(new (class {
        constructor(public url: string) {}
        text() { return Promise.resolve(""); }
      })(url));
    },
    addEventListener(type: string, listener: (event: any) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
  };
  new Script(source).runInNewContext(context);
  return { listeners, fetchCalls, context };
}

test("manifest uses relative scope and the required Hebrew PWA metadata", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./index.html");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "he");
  assert.equal(manifest.dir, "rtl");
  assert.equal(manifest.icons[0].src, "./assets/icon-192.png");
  assert.equal(manifest.icons[1].src, "./assets/icon-512.png");
});

test("app script installs only on user click, recovers after dismiss, and hides install when standalone", async () => {
  const deferred = {
    promptCalls: 0,
    prompt() {
      this.promptCalls += 1;
    },
    userChoice: Promise.resolve({ outcome: "dismissed" }),
    preventDefault() {},
  };
  const harness = appHarness({ standalone: false });
  assert.equal(harness.installButton.hidden, true);
  harness.context.dispatch("beforeinstallprompt", deferred);
  assert.equal(harness.installButton.hidden, false);
  assert.equal(deferred.promptCalls, 0);
  await harness.installButton.dispatch("click", { preventDefault() {} });
  assert.equal(deferred.promptCalls, 1);
  assert.equal(harness.installButton.hidden, true);
  harness.installButton.dispatch("click", { preventDefault() {} });
  assert.equal(deferred.promptCalls, 1, "A consumed browser prompt cannot be reused");
  assert.match(harness.appStatus.textContent, /אפשר לנסות שוב|ההתקנה נדחתה/);

  const accepted = {
    promptCalls: 0,
    prompt() {
      this.promptCalls += 1;
    },
    userChoice: Promise.resolve({ outcome: "accepted" }),
    preventDefault() {},
  };
  harness.context.dispatch("beforeinstallprompt", accepted);
  await harness.installButton.dispatch("click", { preventDefault() {} });
  assert.equal(accepted.promptCalls, 1);
  harness.context.dispatch("appinstalled");
  assert.equal(harness.installButton.hidden, true);

  const installedHarness = appHarness({ standalone: true });
  assert.equal(installedHarness.installButton.hidden, true);
  assert.ok(installedHarness.matchMediaCalls.includes("(display-mode: standalone)"));
});

test("app script opens and closes the native guide, reuses the validated manager href, and shows registration failures", async () => {
  const harness = appHarness({ registerReject: true, managerHref: "https://github.com/analyst/market-reports/actions/workflows/reports.yml" });
  harness.openHelpButton.dispatch("click", { preventDefault() {} });
  assert.equal(harness.helpDialog.showModalCount, 1);
  assert.equal(harness.helpManagement.href, harness.manageReports.href);
  harness.helpDialog.dispatch("cancel", { preventDefault() {}, target: harness.helpDialog });
  assert.equal(harness.helpDialog.open, false);
  harness.openHelpButton.focusCount = 0;
  harness.openHelpButton.dispatch("click", { preventDefault() {} });
  harness.closeHelpButton.dispatch("click", { preventDefault() {} });
  assert.equal(harness.helpDialog.open, false);
  assert.equal(harness.openHelpButton.focusCount > 0, true);
  harness.openHelpButton.dispatch("click");
  harness.helpDialog.dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(harness.helpDialog.open, false, "Escape closes the help even when no native cancel event is emitted");
  await Promise.resolve();
  assert.match(harness.appStatus.textContent, /Service Worker|חיבור מאובטח|לא הופעל/);
});

test("app script registers the service worker only in secure http contexts and keeps the scope under the project base", async () => {
  const secureHarness = appHarness({ url: "https://analyst.github.io/stock/index.html", secure: true });
  await Promise.resolve();
  assert.deepEqual(secureHarness.registrations, ["https://analyst.github.io/stock/service-worker.js|https://analyst.github.io/stock/"]);

  const fileHarness = appHarness({ url: "file:///C:/reports/index.html", secure: false });
  await Promise.resolve();
  assert.deepEqual(fileHarness.registrations, []);
  assert.match(fileHarness.appStatus.textContent, /Chrome ב-Android|חיבור מאובטח|ללא התקנה/);
});

test("service worker intercepts only scoped same-origin GET navigations and returns an explicit offline page", async () => {
  const harness = workerHarness();
  const fetchListener = harness.listeners.get("fetch")?.[0];
  assert.ok(fetchListener, "fetch listener is required");

  let respondWithPromise: Promise<any> | undefined;
  fetchListener({
    request: { method: "GET", mode: "navigate", url: "https://analyst.github.io/stock/reports/report-daily-2026-09-07.html" },
    respondWith(value: Promise<any>) {
      respondWithPromise = value;
    },
  });
  const successResponse = await respondWithPromise;
  assert.equal(harness.fetchCalls[0].url, "https://analyst.github.io/stock/reports/report-daily-2026-09-07.html");
  assert.equal(harness.fetchCalls[0].cache, "no-store");
  assert.ok(successResponse);

  respondWithPromise = undefined;
  fetchListener({
    request: { method: "GET", mode: "navigate", url: "https://analyst.github.io/stock/offline" },
    respondWith(value: Promise<any>) {
      respondWithPromise = value;
    },
  });
  const offlineResponse = await respondWithPromise;
  const offlineHtml = await offlineResponse.text();
  assert.match(offlineHtml, /הדוח אינו זמין כעת/);
  assert.match(offlineHtml, /נסה שוב/);
  assert.doesNotMatch(offlineHtml, /https?:\/\//);

  for (const request of [
    { method: "POST", mode: "navigate", url: "https://analyst.github.io/stock/reports/report-daily-2026-09-07.html" },
    { method: "GET", mode: "cors", url: "https://analyst.github.io/stock/app.js" },
    { method: "GET", mode: "navigate", url: "https://example.com/stock/report.html" },
    { method: "GET", mode: "navigate", url: "https://analyst.github.io/other/index.html" },
  ]) {
    let touched = false;
    fetchListener({
      request,
      respondWith() {
        touched = true;
      },
    });
    assert.equal(touched, false);
  }
});

test("a rejected installation prompt is handled without leaving a broken action", async () => {
  const harness = appHarness();
  harness.context.dispatch("beforeinstallprompt", {
    preventDefault() {}, prompt() { throw new Error("InvalidStateError"); },
    userChoice: Promise.resolve({ outcome: "dismissed" }),
  });
  await harness.installButton.dispatch("click");
  assert.equal(harness.installButton.hidden, true);
  assert.match(harness.appStatus.textContent, /Chrome/);
});