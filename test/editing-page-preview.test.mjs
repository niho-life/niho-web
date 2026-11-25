import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { capturePagePreview } from "../cli/page-preview.mjs";

const previewUrl = "https://site.example/_private-preview/page";
const authorizationHeaders = { Authorization: "Bearer fixture", "CF-Access-Client-Id": "access-id", "CF-Access-Client-Secret": "access-secret" };
const htmlHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow"
};

test("preview URL is returned without fetching when no headless browser is available", async () => {
  let fetchCount = 0;
  const result = await capturePagePreview({ url: previewUrl, widths: [375, 768, 1280], authorizationHeaders }, {
    async launch() { return null; },
    async fetcher() { fetchCount++; throw new Error("must not fetch without a browser"); }
  });
  assert.equal(result, undefined);
  assert.equal(fetchCount, 0);
});

test("preview HTML is fetched once with host auth and reused for each viewport without giving credentials to Chromium", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "niho-edit-preview-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const pageRecords = [];
  const browser = {
    async newPage(options) {
      assert.equal(options.viewport.height, 900);
      assert.equal(options.serviceWorkers, "block");
      assert.equal(options.acceptDownloads, false);
      const record = { initialWidth: options.viewport.width, width: null, html: null, screenshotPaths: [], route: null };
      pageRecords.push(record);
      return {
        async route(matcher, handler, routeOptions) { record.route = { matcher, handler, routeOptions }; },
        async goto(url) {
          record.url = url;
          if (record.route) {
            assert.equal(record.route.matcher({ href: url }), true);
            assert.equal(record.route.matcher({ href: "https://site.example/other" }), false);
            let fulfilled = 0;
            await record.route.handler({ async fulfill(payload) { fulfilled++; record.html = payload; } });
            assert.equal(fulfilled, 1);
          }
          return { ok: () => true };
        },
        url() { return record.url; },
        async setViewportSize({ width }) { record.width = width; },
        async setContent(html) { record.comparisonHtml = html; },
        async screenshot({ path }) { record.screenshotPaths.push({ width: record.width ?? record.initialWidth, path }); return Buffer.from(`${record.width ?? record.initialWidth}`); },
        async close() {}
      };
    },
    async close() { browser.closed = true; }
  };
  let fetchCount = 0;
  const screenshots = await capturePagePreview({
    url: previewUrl,
    publishedUrl: "https://site.example/published/home",
    widths: [375, 768, 1280],
    out,
    authorizationHeaders
  }, {
    async launch() { return browser; },
    async fetcher(url, options) {
      fetchCount++;
      assert.equal(url, previewUrl);
      const requestHeaders = new Headers(options.headers);
      for (const [name, value] of Object.entries(authorizationHeaders)) assert.equal(requestHeaders.get(name), value);
      assert.equal(requestHeaders.get("accept"), "text/html");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.equal(options.referrerPolicy, "no-referrer");
      return new Response("<!doctype html><title>Draft</title>", { status: 200, headers: htmlHeaders });
    }
  });

  assert.equal(fetchCount, 1);
  assert.equal(browser.closed, true);
  assert.equal(pageRecords.length, 5);
  assert.equal(pageRecords[0].route.routeOptions.times, 1);
  assert.equal(pageRecords[0].html.status, 200);
  assert.equal(pageRecords[0].html.body.toString(), "<!doctype html><title>Draft</title>");
  assert.equal(pageRecords[0].html.headers["referrer-policy"], "no-referrer");
  assert.equal(pageRecords[1].route, null);
  assert.deepEqual(pageRecords.slice(2).map(({ initialWidth }) => initialWidth), [750, 1536, 2560]);
  assert.ok(pageRecords.slice(2).every(({ comparisonHtml }) => (comparisonHtml.match(/data:image\/png;base64,/gu) ?? []).length === 2));
  assert.equal(screenshots.length, 3);
  assert.deepEqual(screenshots.map(({ width }) => width), [375, 768, 1280]);
  assert.deepEqual(pageRecords[0].screenshotPaths.map(({ width }) => width), [375, 768, 1280]);
  assert.deepEqual(pageRecords[1].screenshotPaths.map(({ width }) => width), [375, 768, 1280]);
  assert.ok(screenshots.every(({ preview, published, comparison }) => basename(preview).startsWith("draft-")
    && basename(published).startsWith("published-") && basename(comparison).startsWith("compare-")));
});

test("preview capture rejects HTML responses without no-store, no-referrer and noindex", async () => {
  let closed = false;
  const browser = { async close() { closed = true; } };
  await assert.rejects(capturePagePreview({ url: previewUrl, widths: [375], authorizationHeaders }, {
    async launch() { return browser; },
    async fetcher() { return new Response("<title>unsafe</title>", { headers: { "Content-Type": "text/html" } }); }
  }), /invalid preview HTML response/u);
  assert.equal(closed, true);
});
