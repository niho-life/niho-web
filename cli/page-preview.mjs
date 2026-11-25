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

async function readPreviewHtml(url, authorizationHeaders, fetcher) {
  // Keep the credentials out of the browser and refuse redirects before they can receive headers.
  const response = await fetcher(url, {
    headers: { ...authorizationHeaders, Accept: "text/html" }, credentials: "omit", redirect: "error",
    cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const cache = response.headers.get("cache-control")?.toLowerCase().split(",").map((value) => value.trim());
  const robots = response.headers.get("x-robots-tag")?.toLowerCase().split(",").map((value) => value.trim());
  if (response.status !== 200 || !response.body || type !== "text/html" || !cache?.includes("no-store")
    || response.headers.get("referrer-policy")?.toLowerCase() !== "no-referrer" || !robots?.includes("noindex")) {
    await response.body?.cancel();
    throw new Error("invalid preview HTML response");
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error("preview HTML too large");
    }
    chunks.push(value);
  }
  const headers = Object.fromEntries(HTML_HEADERS.flatMap((key) => response.headers.has(key) ? [[key, response.headers.get(key)]] : []));
  return { status: 200, headers, body: Buffer.concat(chunks, total) };
}

export async function capturePagePreview({ url, publishedUrl, widths, out, authorizationHeaders }, { launch = openBrowser, fetcher = fetch } = {}) {
  const browser = await launch();
  if (!browser) return undefined;
  let directory;
  try {
    const html = await readPreviewHtml(url, authorizationHeaders, fetcher);
    const options = { viewport: { width: widths[0], height: CAPTURE_HEIGHT }, serviceWorkers: "block", acceptDownloads: false };
    const draft = await browser.newPage(options);
    await draft.route((target) => target.href === url, (route) => route.fulfill(html), { times: 1 });
    const response = await draft.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
    if (!response?.ok() || draft.url() !== url) throw new Error("preview could not be opened");

    let published;
    if (publishedUrl) {
      published = await browser.newPage(options);
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
