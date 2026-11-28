import { validatePagePath } from "./pages.js";
import { validCmsItemPath } from "./cms-v2-routes.js";

export type ManagedSiteRedirect = {
  readonly locale: string;
  readonly fromPath: string;
  readonly toPath: string;
};

export const MAX_MANAGED_SITE_REDIRECTS = 500;

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const REDIRECT_KEYS = ["fromPath", "locale", "toPath"] as const;

/** Parse an entire versioned redirect snapshot, rejecting ambiguous paths and loops. */
export function parseManagedSiteRedirects(value: unknown, maximum = MAX_MANAGED_SITE_REDIRECTS,
  options: { readonly includeCmsPaths?: boolean } = {}): ManagedSiteRedirect[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const redirects: ManagedSiteRedirect[] = [];
  const bySource = new Map<string, string>();
  const pathAllowed = (path: unknown): path is string => typeof path === "string"
    && (options.includeCmsPaths ? validCmsItemPath(path) !== null : validatePagePath(path) === null);
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== REDIRECT_KEYS.length || keys.some((key, index) => key !== REDIRECT_KEYS[index])) return null;
    const { locale, fromPath, toPath } = record;
    if (typeof locale !== "string" || locale.length > 40 || !LOCALE.test(locale)
      || !pathAllowed(fromPath) || !pathAllowed(toPath) || fromPath === toPath || bySource.has(fromPath)) return null;
    bySource.set(fromPath, toPath);
    redirects.push({ locale, fromPath, toPath });
  }
  const complete = new Set<string>();
  for (const { fromPath } of redirects) {
    const trail: string[] = [], active = new Set<string>();
    let path: string | undefined = fromPath;
    while (path !== undefined && bySource.has(path) && !complete.has(path)) {
      if (active.has(path)) return null;
      active.add(path);
      trail.push(path);
      path = bySource.get(path);
    }
    for (const visited of trail) complete.add(visited);
  }
  return redirects;
}
