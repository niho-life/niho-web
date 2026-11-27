#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = `Usage:
  node scripts/compare-public-ttfb.mjs --baseline <https-url> --candidate <https-url> [options]

Options:
  --path <path>             Route to request; repeat for more routes (default: /)
  --warm-samples <count>    Repeated requests per route and site (default: 5, max: 50)
  --timeout-ms <count>      Per-request timeout (default: 10000)
  --location <label>        Measurement location to include in the report
  --help                    Show this help

The first request is reported separately from repeated requests. HTTP cannot confirm
whether a Cloudflare isolate was cold; run from the intended region after an idle
period when collecting a cold-start proxy measurement.`;

function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return parsed;
}

export function parseArgs(argv) {
  const options = { path: [], warmSamples: 5, timeoutMs: 10_000, location: "unspecified" };
  const values = new Map([
    ["--baseline", (value) => { options.baseline = value; }],
    ["--candidate", (value) => { options.candidate = value; }],
    ["--path", (value) => { options.path.push(value); }],
    ["--warm-samples", (value) => { options.warmSamples = positiveInteger(value, "--warm-samples", 50); }],
    ["--timeout-ms", (value) => { options.timeoutMs = positiveInteger(value, "--timeout-ms", 120_000); }],
    ["--location", (value) => { options.location = value; }]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    const setter = values.get(flag);
    if (!setter) throw new Error(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    setter(value);
    index += 1;
  }
  if (!options.baseline || !options.candidate) throw new Error("--baseline and --candidate are required");
  options.path = options.path.length ? options.path : ["/"];
  for (const path of options.path) {
    if (!path.startsWith("/") || path.startsWith("//") || /[?#\\\u0000-\u001f\u007f]/u.test(path) || path.split("/").includes("..")) {
      throw new Error(`invalid --path: ${path}`);
    }
  }
  return options;
}

function baseUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} cannot include credentials, a query, or a fragment`);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function routeUrl(base, path) {
  const route = path.replace(/^\/+/, "");
  const result = new URL(route, base);
  if (result.origin !== base.origin || !result.pathname.startsWith(base.pathname)) throw new Error(`route escaped base URL: ${path}`);
  return result;
}

function round(value) { return Math.round(value * 10) / 10; }

function quantile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * fraction;
  const low = Math.floor(index), high = Math.ceil(index);
  return round(ordered[low] + (ordered[high] - ordered[low]) * (index - low));
}

function stats(samples) {
  const times = samples.map(({ ttfbMs }) => ttfbMs);
  return { count: times.length, medianMs: quantile(times, 0.5), p75Ms: quantile(times, 0.75), p95Ms: quantile(times, 0.95) };
}

async function measure(url, timeoutMs) {
  const started = performance.now();
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const ttfbMs = round(performance.now() - started);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  await response.arrayBuffer();
  return {
    ttfbMs,
    status: response.status,
    cacheStatus: response.headers.get("cf-cache-status") ?? response.headers.get("x-cache"),
    finalUrl: response.url
  };
}

function delta(candidate, baseline) {
  const differenceMs = round(candidate - baseline);
  return { differenceMs, differencePercent: round((differenceMs / baseline) * 100) };
}

export async function comparePublicTtfb({ baseline, candidate, path = ["/"], warmSamples = 5, timeoutMs = 10_000, location = "unspecified" }) {
  const baselineBase = baseUrl(baseline, "--baseline"), candidateBase = baseUrl(candidate, "--candidate");
  const routes = Array.isArray(path) ? path : [path];
  const results = [];
  for (const route of routes) {
    const siteSamples = { baseline: [], candidate: [] };
    for (let sample = 0; sample <= warmSamples; sample += 1) {
      const order = sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const site of order) {
        const base = site === "baseline" ? baselineBase : candidateBase;
        siteSamples[site].push(await measure(routeUrl(base, route), timeoutMs));
      }
    }
    const baselineFirst = siteSamples.baseline[0];
    const candidateFirst = siteSamples.candidate[0];
    const baselineWarm = siteSamples.baseline.slice(1);
    const candidateWarm = siteSamples.candidate.slice(1);
    const baselineStats = stats(baselineWarm), candidateStats = stats(candidateWarm);
    results.push({
      path: route,
      firstRequest: {
        baseline: baselineFirst,
        candidate: candidateFirst,
        delta: delta(candidateFirst.ttfbMs, baselineFirst.ttfbMs)
      },
      repeatedRequests: {
        baseline: baselineStats,
        candidate: candidateStats,
        medianDelta: delta(candidateStats.medianMs, baselineStats.medianMs)
      }
    });
  }
  const baselineFirstMedian = quantile(results.map(({ firstRequest }) => firstRequest.baseline.ttfbMs), 0.5);
  const candidateFirstMedian = quantile(results.map(({ firstRequest }) => firstRequest.candidate.ttfbMs), 0.5);
  const baselineWarmMedian = quantile(results.map(({ repeatedRequests }) => repeatedRequests.baseline.medianMs), 0.5);
  const candidateWarmMedian = quantile(results.map(({ repeatedRequests }) => repeatedRequests.candidate.medianMs), 0.5);
  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    location,
    nodeVersion: process.version,
    warmSamples,
    firstRequestNote: "First request per route; HTTP cannot confirm that the edge isolate was cold.",
    results,
    summary: {
      routeCount: results.length,
      firstRequestMedian: {
        baselineMs: baselineFirstMedian,
        candidateMs: candidateFirstMedian,
        delta: delta(candidateFirstMedian, baselineFirstMedian)
      },
      repeatedRequestMedian: {
        baselineMs: baselineWarmMedian,
        candidateMs: candidateWarmMedian,
        delta: delta(candidateWarmMedian, baselineWarmMedian)
      }
    }
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(`${usage}\n`); return; }
    const report = await comparePublicTtfb({ ...options, path: options.path });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "benchmark failed"}\n${usage}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
