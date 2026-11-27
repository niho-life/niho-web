import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { comparePublicTtfb, parseArgs } from "../scripts/compare-public-ttfb.mjs";

test("public TTFB comparison reports a first request and repeated-request percentiles", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cf-cache-status", request.url?.includes("baseline") ? "MISS" : "HIT");
    response.end("<html></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const report = await comparePublicTtfb({ baseline: `${origin}/baseline`, candidate: `${origin}/candidate`, path: ["/", "/en/about"], warmSamples: 2, timeoutMs: 1_000, location: "local-test" });
    assert.equal(report.location, "local-test");
    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].firstRequest.baseline.status, 200);
    assert.equal(report.results[0].firstRequest.baseline.cacheStatus, "MISS");
    assert.equal(report.results[0].repeatedRequests.candidate.count, 2);
    assert.equal(typeof report.results[0].repeatedRequests.candidate.medianMs, "number");
    assert.equal(report.summary.routeCount, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public TTFB CLI validates base URLs and route paths", async () => {
  assert.deepEqual(parseArgs(["--baseline", "https://baseline.example", "--candidate", "https://candidate.example", "--path", "/en/" ]).path, ["/en/"]);
  assert.throws(() => parseArgs(["--baseline", "https://baseline.example", "--candidate", "https://candidate.example", "--path", "/../outside"]), /invalid --path/u);
  await assert.rejects(comparePublicTtfb({ baseline: "http://example.test", candidate: "https://candidate.example", path: "/" }), /must use HTTPS/u);
});

test("public TTFB comparison rejects an error response instead of reporting it as faster", async () => {
  let candidateRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.includes("candidate") && ++candidateRequests > 1) {
      response.writeHead(503).end("temporarily unavailable"); return;
    }
    response.end("<html></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(comparePublicTtfb({ baseline: `${origin}/baseline`, candidate: `${origin}/candidate`, warmSamples: 2, timeoutMs: 1_000 }), /HTTP 503/u);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
