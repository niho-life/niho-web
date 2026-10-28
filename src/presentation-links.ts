import { fail, keys, record } from "./validation-utils.js";
import type { SitePresentationLinks } from "./types.js";
export function parsePresentationLinks(input: unknown): SitePresentationLinks {
  const value = record(input, "presentation.links");
  keys(value, ["origin", "sourcePath", "paths"], "presentation.links");
  let origin: URL;
  try { origin = new URL(String(value.origin)); } catch { return fail("presentation.links.origin", "invalid origin"); }
  if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password) fail("presentation.links.origin", "invalid origin");
  const validPath = (path: unknown): path is string => typeof path === "string" && /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path) && path.length <= 200;
  if (!validPath(value.sourcePath)) fail("presentation.links.sourcePath", "invalid path");
  const paths = record(value.paths, "presentation.links.paths");
  if (Object.keys(paths).length > 2000 || Object.entries(paths).some(([from, to]) => !validPath(from) || !validPath(to))) fail("presentation.links.paths", "invalid paths");
  return { origin: origin.origin, sourcePath: value.sourcePath, paths: { ...paths } as Record<string, string> };
}
export function resolvePageLink(value: string, routing: SitePresentationLinks): string {
  if (!value || /^[#?]/.test(value) || /[\\\u0000-\u0020]/u.test(value)) return value;
  const split = /^([^?#]*)([?#].*)?$/.exec(value);
  if (!split) return value;
  let url: URL;
  try { url = new URL(split[1]!, new URL(routing.sourcePath, routing.origin)); } catch { return value; }
  if (url.origin !== routing.origin || url.username || url.password || !["https:", "http:"].includes(url.protocol)) return value;
  const path = url.pathname.replace(/\/+$/, "") || "/", target = routing.paths[path];
  if (!target) return value;
  const suffix = split[2] ?? "";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? routing.origin + target + suffix : value.startsWith("//") ? "//" + url.host + target + suffix : target + suffix;
}
