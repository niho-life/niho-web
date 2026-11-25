import { PAGE_LIMITS, isTemplatePath, matchesTemplatePath } from "./pages.js";
import { fail, keys, localeCode, record, string } from "./validation-utils.js";

export type CmsRouteReservation =
  | { readonly kind: "cms-item"; readonly path: string; readonly collectionId: string; readonly itemId: string }
  | { readonly kind: "redirect"; readonly path: string; readonly targetPath: string; readonly owner: "cms" | "host" }
  | { readonly kind: "fixed-page"; readonly path: string; readonly reservationId: string }
  | { readonly kind: "template"; readonly path: string; readonly reservationId: string }
  | { readonly kind: "reserved"; readonly path: string; readonly reservationId: string };

/** One immutable route registry for exactly one site and locale. Paths are case-sensitive URL paths. */
export type CmsRouteTable = {
  readonly siteId: string;
  readonly locale: string;
  readonly revision: string;
  readonly reservations: readonly CmsRouteReservation[];
};
export type CmsRouteTableVersion = { readonly locale: string; readonly revision: string };
export type CmsRouteCandidate = { readonly path: string; readonly collectionId: string; readonly itemId: string };
export type CmsRouteProblem = {
  readonly code: "route";
  readonly message: string;
  readonly collectionId?: string;
  readonly itemId?: string;
  readonly path?: string;
};
export type CmsRouteTablePlan = { readonly table: CmsRouteTable; readonly problems: readonly CmsRouteProblem[] };

const STATIC_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const DYNAMIC_SEGMENT = /^\[[a-z][a-zA-Z0-9_]*\]$/u;
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9:._~-]{0,127}$/u;
const segmentsOf = (path: string) => path === "/" ? [] : path.slice(1).split("/");
const itemKey = (item: Pick<CmsRouteCandidate, "collectionId" | "itemId">) => `${item.collectionId}/${item.itemId}`;

function routePath(input: unknown, path: string, template: boolean): string {
  if (typeof input !== "string" || input.length > PAGE_LIMITS.pathLength || !input.startsWith("/")
    || input.includes("//") || (input !== "/" && input.endsWith("/")) || /[?#%\\\s\u0000-\u001f\u007f]/u.test(input)) {
    fail(path, "invalid normalized route path");
  }
  const segments = segmentsOf(input);
  if (segments.length > PAGE_LIMITS.pathDepth || (input === "/" && template)) fail(path, "invalid normalized route path");
  if (segments.some((segment) => !STATIC_SEGMENT.test(segment) && !(template && DYNAMIC_SEGMENT.test(segment)))) {
    fail(path, "invalid normalized route path");
  }
  if (template && !isTemplatePath(input)) fail(path, "invalid route template");
  return input;
}
function identifier(input: unknown, path: string): string {
  const value = string(input, path, 128);
  if (!SAFE_ID.test(value)) fail(path, "invalid route reservation ID");
  return value;
}
function parseReservation(input: unknown, path: string): CmsRouteReservation {
  const value = record(input, path);
  if (value.kind === "cms-item") {
    keys(value, ["kind", "path", "collectionId", "itemId"], path);
    return { kind: value.kind, path: routePath(value.path, `${path}.path`, false),
      collectionId: identifier(value.collectionId, `${path}.collectionId`), itemId: identifier(value.itemId, `${path}.itemId`) };
  }
  if (value.kind === "redirect") {
    keys(value, ["kind", "path", "targetPath", "owner"], path);
    if (value.owner !== "cms" && value.owner !== "host") fail(`${path}.owner`, "invalid redirect owner");
    return { kind: value.kind, path: routePath(value.path, `${path}.path`, false),
      targetPath: routePath(value.targetPath, `${path}.targetPath`, false), owner: value.owner };
  }
  if (value.kind === "fixed-page" || value.kind === "reserved") {
    keys(value, ["kind", "path", "reservationId"], path);
    return { kind: value.kind, path: routePath(value.path, `${path}.path`, false), reservationId: identifier(value.reservationId, `${path}.reservationId`) };
  }
  if (value.kind === "template") {
    keys(value, ["kind", "path", "reservationId"], path);
    return { kind: value.kind, path: routePath(value.path, `${path}.path`, true), reservationId: identifier(value.reservationId, `${path}.reservationId`) };
  }
  return fail(`${path}.kind`, "unknown route reservation kind");
}

export function parseCmsRouteTable(input: unknown, expectedSiteId?: string, expectedLocale?: string): CmsRouteTable {
  const value = record(input, "routeTable");
  keys(value, ["siteId", "locale", "revision", "reservations"], "routeTable");
  const siteId = identifier(value.siteId, "routeTable.siteId"), locale = localeCode(value.locale, "routeTable.locale");
  if ((expectedSiteId !== undefined && siteId !== expectedSiteId) || (expectedLocale !== undefined && locale !== expectedLocale)) {
    fail("routeTable", "CMS route table site or locale mismatch");
  }
  const revision = identifier(value.revision, "routeTable.revision");
  if (!Array.isArray(value.reservations) || value.reservations.length > 100_000) fail("routeTable.reservations", "invalid route reservation list");
  const reservations = value.reservations.map((entry, index) => parseReservation(entry, `routeTable.reservations[${index}]`));
  const sourceKeys = reservations.map((entry) => entry.kind === "cms-item" ? `${entry.kind}:${itemKey(entry)}` : `${entry.kind}:${entry.path}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) fail("routeTable.reservations", "duplicate route reservation");
  return { siteId, locale, revision, reservations: [...reservations].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) };
}

function isTemplate(reservation: CmsRouteReservation): boolean { return reservation.kind === "template"; }
function templatePatternsOverlap(left: string, right: string): boolean {
  const a = segmentsOf(left), b = segmentsOf(right);
  return a.length === b.length && a.every((segment, index) => DYNAMIC_SEGMENT.test(segment) || DYNAMIC_SEGMENT.test(b[index]!) || segment === b[index]);
}
function routesOverlap(left: CmsRouteReservation, right: CmsRouteReservation): boolean {
  if (left.path === right.path) return true;
  if (isTemplate(left) && isTemplate(right)) return templatePatternsOverlap(left.path, right.path);
  if (isTemplate(left)) return matchesTemplatePath(left.path, right.path);
  if (isTemplate(right)) return matchesTemplatePath(right.path, left.path);
  return false;
}
function routeProblem(path: string, message: string, item?: CmsRouteCandidate): CmsRouteProblem {
  return { code: "route", message, path, ...(item ? { collectionId: item.collectionId, itemId: item.itemId } : {}) };
}
function tablePathReservation(path: string, kind: "cms-item" | "redirect", item?: CmsRouteCandidate, targetPath?: string): CmsRouteReservation {
  return kind === "cms-item"
    ? { kind, path, collectionId: item!.collectionId, itemId: item!.itemId }
    : { kind, path, targetPath: targetPath!, owner: "cms" };
}

/** Replace the previous CMS routes atomically while retaining host-owned fixed, template, reserved, and redirect entries. */
export function planCmsRouteTable(input: {
  readonly current: unknown;
  readonly siteId: string;
  readonly locale: string;
  readonly expectedRevision: string;
  readonly nextRevision: string;
  readonly routes: readonly CmsRouteCandidate[];
  readonly redirects: readonly { readonly from: string; readonly to: string }[];
}): CmsRouteTablePlan | { readonly status: "conflict" } {
  const current = parseCmsRouteTable(input.current, input.siteId, input.locale);
  if (current.revision !== input.expectedRevision || current.revision === input.nextRevision) return { status: "conflict" };
  const host = current.reservations.filter((entry) => entry.kind !== "cms-item" && !(entry.kind === "redirect" && entry.owner === "cms"));
  const candidates: CmsRouteReservation[] = [];
  const problems: CmsRouteProblem[] = [];
  const paths = new Map<string, CmsRouteReservation>();

  for (const route of input.routes) {
    let path: string;
    try { path = routePath(route.path, "route.path", false); }
    catch { problems.push(routeProblem(route.path, "公開 URL を予約できません。", route)); continue; }
    const reservation = tablePathReservation(path, "cms-item", route);
    const conflict = [...host, ...candidates].find((entry) => routesOverlap(entry, reservation));
    if (conflict) problems.push(routeProblem(path, "固定ページ・テンプレート・予約済み path または別項目と衝突します。", route));
    const previous = paths.get(path);
    if (previous) problems.push(routeProblem(path, "同じ公開 path の項目があります。", route));
    paths.set(path, reservation);
    candidates.push(reservation);
  }

  const redirectSources = new Set<string>();
  const redirectEntries: CmsRouteReservation[] = [];
  for (const redirect of input.redirects) {
    let from: string, to: string;
    try {
      from = routePath(redirect.from, "redirect.from", false);
      to = routePath(redirect.to, "redirect.to", false);
    } catch { problems.push(routeProblem(redirect.from, "転送 path が正規化されていません。")); continue; }
    if (from === to) {
      problems.push(routeProblem(from, "転送元 path が重複するか、転送先と同じです。"));
      continue;
    }
    if (redirectSources.has(from)) {
      problems.push(routeProblem(from, "転送元 path が重複するか、転送先と同じです。"));
      continue;
    }
    redirectSources.add(from);
    const reservation = tablePathReservation(from, "redirect", undefined, to);
    if ([...host, ...candidates, ...redirectEntries].some((entry) => routesOverlap(entry, reservation))) {
      problems.push(routeProblem(from, "転送元 path が公開 route または予約と衝突します。"));
      continue;
    }
    redirectEntries.push(reservation);
  }

  const liveTargets = [...host.filter((entry) => entry.kind === "fixed-page" || entry.kind === "template"), ...candidates];
  const hostRedirects = host.filter((entry) => entry.kind === "redirect");
  for (const redirect of hostRedirects) {
    const targetPath = redirect.targetPath;
    if (!liveTargets.some((entry) => entry.kind === "template" ? matchesTemplatePath(entry.path, targetPath) : entry.path === targetPath)) {
      problems.push(routeProblem(redirect.path, "ホスト転送先は公開中の固定ページまたは項目にしてください。"));
    }
    if ([...hostRedirects, ...redirectEntries].some((entry) => entry.path === targetPath)) {
      problems.push(routeProblem(redirect.path, "転送を連結できません。"));
    }
  }
  for (const redirect of redirectEntries) {
    const targetPath = redirect.kind === "redirect" ? redirect.targetPath : "";
    if (!liveTargets.some((entry) => entry.kind === "template" ? matchesTemplatePath(entry.path, targetPath) : entry.path === targetPath)) {
      problems.push(routeProblem(redirect.path, "転送先は公開中の固定ページまたは項目にしてください。"));
    }
    if (redirectEntries.some((entry) => entry.path === targetPath)) problems.push(routeProblem(redirect.path, "転送を連結できません。"));
  }

  const table = parseCmsRouteTable({ siteId: current.siteId, locale: current.locale, revision: input.nextRevision,
    reservations: [...host, ...candidates, ...redirectEntries] }, input.siteId, input.locale);
  return { table, problems };
}

/** Check migrated draft paths against the current route table; current paths owned by that same item remain valid. */
export function cmsMigrationRouteProblems(input: { readonly table: unknown; readonly schema: { readonly siteId: string }; readonly routes: readonly CmsRouteCandidate[] }): CmsRouteProblem[] {
  const table = parseCmsRouteTable(input.table, input.schema.siteId);
  const host = table.reservations.filter((entry) => entry.kind !== "cms-item" && !(entry.kind === "redirect" && entry.owner === "cms"));
  const problems: CmsRouteProblem[] = [];
  const seen = new Set<string>();
  for (const route of input.routes) {
    let path: string;
    try { path = routePath(route.path, "route.path", false); }
    catch { problems.push(routeProblem(route.path, "公開 URL を予約できません。", route)); continue; }
    const candidate = tablePathReservation(path, "cms-item", route);
    if (host.some((entry) => routesOverlap(entry, candidate))) problems.push(routeProblem(path, "固定ページ・テンプレート・予約済み path と衝突します。", route));
    if (seen.has(path)) problems.push(routeProblem(path, "同じ公開 path の項目があります。", route));
    seen.add(path);
    if (table.reservations.some((entry) => entry.kind === "cms-item" && itemKey(entry) !== itemKey(route) && routesOverlap(entry, candidate))) {
      problems.push(routeProblem(path, "別の公開 CMS 項目と衝突します。", route));
    }
  }
  return problems;
}
