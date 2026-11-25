import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const CAPTURE_HEIGHT = 900;
const TIMEOUT_MS = 30_000;
const HTML_HEADERS = ["cache-control", "content-language", "content-security-policy", "content-type", "cross-origin-embedder-policy",
  "cross-origin-opener-policy", "cross-origin-resource-policy", "permissions-policy", "referrer-policy", "x-content-type-options", "x-robots-tag"];

async function openBrowser() {
  let moduleUrl;
  try { moduleUrl = import.meta.resolve("playwright"); }
  catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
  const { chromium } = await import(moduleUrl);
  const env = { ...process.env };
  for (const key of ["NIHO_EDIT_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) delete env[key];
  try { return await chromium.launch({ headless: true, timeout: TIMEOUT_MS, env }); }
  catch (error) {
    if (error?.message?.includes("Executable doesn't exist")) return null;
    throw error;
  }
}

function accessServiceHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => /^cf-access-client-(?:id|secret)$/iu.test(name)));
}

async function readBoundedBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error("preview response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function checkedHtmlResponse(response, url, { privateHtml = false } = {}) {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const finalUrl = response.url ? new URL(response.url).href : url;
  if (response.status !== 200 || !response.body || type !== "text/html" || finalUrl !== url) {
    await response.body?.cancel();
    throw new Error("invalid HTML response");
  }
  const cache = response.headers.get("cache-control")?.toLowerCase().split(",").map((value) => value.trim());
  const robots = response.headers.get("x-robots-tag")?.toLowerCase().split(",").map((value) => value.trim());
  if (privateHtml && (!cache?.includes("no-store") || response.headers.get("referrer-policy")?.toLowerCase() !== "no-referrer" || !robots?.includes("noindex"))) {
    await response.body?.cancel();
    throw new Error("preview HTML privacy headers missing");
  }
  const headers = Object.fromEntries(HTML_HEADERS.flatMap((key) => response.headers.has(key) ? [[key, response.headers.get(key)]] : []));
  return { status: 200, headers, body: await readBoundedBody(response) };
}

async function readPreviewHtml(url, authorizationHeaders, fetcher) {
  // Keep the credentials out of the browser and refuse redirects before they can receive headers.
  const response = await fetcher(url, {
    headers: { ...authorizationHeaders, Accept: "text/html" }, credentials: "omit", redirect: "error",
    cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return checkedHtmlResponse(response, url, { privateHtml: true });
}

async function readPublishedHtml(url, trustedOrigin, authorizationHeaders, fetcher) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.origin !== trustedOrigin || target.username || target.password) throw new Error("published URL origin mismatch");
  const response = await fetcher(url, {
    headers: { ...accessServiceHeaders(authorizationHeaders), Accept: "text/html" }, credentials: "omit", redirect: "error",
    cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return checkedHtmlResponse(response, target.href);
}

async function installPageRoutes(page, { primaryUrl, html, trustedOrigin, authorizationHeaders, fetcher }) {
  const accessHeaders = accessServiceHeaders(authorizationHeaders);
  await page.route(() => true, async (route) => {
    const request = route.request(), requestUrl = request.url(), method = request.method().toUpperCase();
    if (method === "GET" && requestUrl === primaryUrl) { await route.fulfill(html); return; }
    if (method !== "GET" && method !== "HEAD") { await route.abort("blockedbyclient"); return; }
    let target;
    try { target = new URL(requestUrl); } catch { await route.abort("blockedbyclient"); return; }
    if (target.protocol !== "https:" || target.origin !== trustedOrigin || Object.keys(accessHeaders).length === 0) {
      await route.continue(); return;
    }
    try {
      const accept = request.headers().accept;
      const response = await fetcher(requestUrl, {
        method, headers: { ...accessHeaders, ...(accept ? { Accept: accept } : {}) }, credentials: "omit", redirect: "error",
        cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (response.status >= 300 && response.status < 400) throw new Error("resource redirect refused");
      const headers = Object.fromEntries(HTML_HEADERS.flatMap((key) => response.headers.has(key) ? [[key, response.headers.get(key)]] : []));
      await route.fulfill({ status: response.status, headers, body: method === "HEAD" ? Buffer.alloc(0) : await readBoundedBody(response) });
    } catch { await route.abort("failed"); }
  });
}

export async function capturePagePreview({ url, publishedUrl, widths, out, authorizationHeaders }, { launch = openBrowser, fetcher = fetch } = {}) {
  const browser = await launch();
  if (!browser) return undefined;
  let directory;
  try {
    const trustedOrigin = new URL(url).origin;
    const html = await readPreviewHtml(url, authorizationHeaders, fetcher);
    const options = { viewport: { width: widths[0], height: CAPTURE_HEIGHT }, serviceWorkers: "block", acceptDownloads: false };
    const draft = await browser.newPage(options);
    await installPageRoutes(draft, { primaryUrl: url, html, trustedOrigin, authorizationHeaders, fetcher });
    const response = await draft.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
    if (!response?.ok() || draft.url() !== url) throw new Error("preview could not be opened");

    let published;
    if (publishedUrl) {
      const publishedHtml = await readPublishedHtml(publishedUrl, trustedOrigin, authorizationHeaders, fetcher);
      published = await browser.newPage(options);
      await installPageRoutes(published, { primaryUrl: publishedUrl, html: publishedHtml, trustedOrigin, authorizationHeaders, fetcher });
      const liveResponse = await published.goto(publishedUrl, { waitUntil: "load", timeout: TIMEOUT_MS });
      if (!liveResponse?.ok()) throw new Error("published page could not be opened");
    }
    const outputRoot = resolve(out ?? ".");
    await mkdir(outputRoot, { recursive: true });
    directory = await mkdtemp(join(outputRoot, "niho-preview-"));
    const screenshots = [];
    for (const width of widths) {
      const viewport = { width, height: CAPTURE_HEIGHT };
      await draft.setViewportSize(viewport);
      if (draft.url() !== url) throw new Error("preview navigated away");
      const preview = join(directory, `draft-${width}.png`);
      const previewImage = await draft.screenshot({ path: preview, timeout: TIMEOUT_MS });
      const entry = { width, preview };
      if (published) {
        await published.setViewportSize(viewport);
        entry.published = join(directory, `published-${width}.png`);
        const publishedImage = await published.screenshot({ path: entry.published, timeout: TIMEOUT_MS });
        const comparison = await browser.newPage({ viewport: { width: width * 2, height: CAPTURE_HEIGHT }, serviceWorkers: "block", acceptDownloads: false });
        const imageData = (image) => Buffer.from(image).toString("base64");
        await comparison.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${width * 2}px;height:${CAPTURE_HEIGHT}px;overflow:hidden}.pair{display:grid;grid-template-columns:repeat(2,${width}px)}img{display:block;width:${width}px;height:${CAPTURE_HEIGHT}px;object-fit:contain}</style><main class="pair"><img alt="下書き" src="data:image/png;base64,${imageData(previewImage)}"><img alt="公開版" src="data:image/png;base64,${imageData(publishedImage)}"></main>`, { waitUntil: "load", timeout: TIMEOUT_MS });
        entry.comparison = join(directory, `compare-${width}.png`);
        await comparison.screenshot({ path: entry.comparison, timeout: TIMEOUT_MS });
        await comparison.close();
      }
      screenshots.push(entry);
    }
    return screenshots;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await browser.close();
  }
}
