import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ensureTls, fetchInvestingPrice, fetchQuoteInfo, fetchQuoteSummary, fetchTasePrice } from "../src/data.js";

test("Investing failures cancel unread response bodies before returning no price", async context => {
  let requests = 0;
  let cancelled = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("blocked response")); },
      cancel() { cancelled++; },
    }), { status: 403 });
  });

  assert.equal(await fetchInvestingPrice("https://www.investing.com/etfs/test"), null);
  assert.equal(requests, 3);
  assert.equal(cancelled, requests, "Every discarded response must release its body");
});

test("connectivity probe releases the response even when it only checks headers", async context => {
  let cancelled = false;
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })));
  await ensureTls();
  assert.equal(cancelled, true);
});

test("Yahoo cookie and failed chart or fundamental responses are released before retries", async context => {
  const originalTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: () => void) => originalTimeout(callback, 1));
  let discarded = 0;
  let cancelled = 0;
  let status = 404;
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("getcrumb")) return new Response("fixture-crumb");
    discarded++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: url === "https://fc.yahoo.com" ? 302 : status,
      headers: { "set-cookie": "fixture-cookie=value; Path=/" },
    });
  });
  for (status of [404, 401, 403, 429, 500]) {
    if (status === 404) assert.equal(await fetchQuoteSummary("FIXTURE", ["summaryDetail"]), null);
    else await assert.rejects(fetchQuoteSummary("FIXTURE", ["summaryDetail"]));
    assert.equal(cancelled, discarded, `quoteSummary status ${status}`);
    assert.deepEqual(await fetchQuoteInfo("FIXTURE"), { symbol: "FIXTURE" });
    assert.equal(cancelled, discarded, `chart status ${status}`);
  }
});

test("secondary TASE price failures release both rejected response bodies", async context => {
  let cancelled = 0;
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled++; },
  }), { status: 403 }));
  assert.equal(await fetchTasePrice("1234567"), null);
  assert.equal(cancelled, 2);
});

test("successful market prices still consume their bodies and parse unchanged", async context => {
  context.mock.method(globalThis, "fetch", async () => new Response('<span data-test="instrument-price-last">1,234.50</span>'));
  assert.equal(await fetchInvestingPrice("https://www.investing.com/etfs/test"), 1234.5);
  context.mock.method(globalThis, "fetch", async () => Response.json({ LastRate: 987.6 }));
  assert.equal(await fetchTasePrice("1234567"), 987.6);
});

test("price-fetch process exits naturally when rejected HTTP bodies never finish", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.write("blocked response that stays open");
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/fixture`;
    const script = `
      import { fetchInvestingPrice } from ${JSON.stringify(new URL("../src/data.ts", import.meta.url).href)};
      const price = await fetchInvestingPrice(${JSON.stringify(url)});
      console.log(JSON.stringify({ price }));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
    try {
      const [exitCode] = await once(child, "close");
      assert.equal(timedOut, false, "Completed price request kept the child process alive");
      assert.equal(exitCode, 0, errors);
      assert.deepEqual(JSON.parse(output.trim()), { price: null });
      assert.equal(requests, 3);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
  }
});