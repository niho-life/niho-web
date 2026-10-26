/**
 * 言語全体の公開（publish / rollback）の型と parser。
 * ページ編集（editor）の EditorLocaleRelease* と、翻訳の画面（LocalizationWorkspace）の両方が使う。
 * editor-types.ts と editor-locale-release.ts は互換のため、ここから再 export する。
 */
import type { LocalizationLocale } from "./localization-types.js";
import { fail, isSafeHttpsOrigin, keys, record } from "./validation-utils.js";

/* ---------- ページ編集の言語全体の公開（editor-types.ts から移した型） ---------- */

export type EditorLocaleReleaseSummary = {
  releaseId: string;
  version: string;
  label: string;
  publishedAt: string;
  pages: number;
  sharedResources: number;
};
export type EditorLocaleReleaseState = {
  siteId: string;
  locale: LocalizationLocale;
  /** CAS identity of the current locale release; null before first activation. */
  current: EditorLocaleReleaseSummary | null;
  /** Immutable prior whole-locale releases, newest first. */
  history: readonly EditorLocaleReleaseSummary[];
};
export type EditorLocaleReleasePrepareRequest = {
  siteId: string;
  locale: LocalizationLocale;
  action: "publish" | "rollback";
  expectedSiteVersion: string;
  expectedCurrentVersion: string | null;
  rollbackReleaseId?: string;
};
export type EditorLocaleReleasePlan = EditorLocaleReleasePrepareRequest & {
  confirmationToken: string;
  domain: string;
  expiresAt: string;
  optimisticVersion: string;
  previous: EditorLocaleReleaseSummary | null;
  prepared: EditorLocaleReleaseSummary;
  pages: readonly { pageId: string; title: string; path: string; complete: boolean; reasons: readonly string[] }[];
  sharedResources: readonly { id: string; label: string; kind: "component" | "navigation" | "style" | "resource"; complete: boolean; reasons: readonly string[] }[];
  incompleteReasons: readonly string[];
  complete: boolean;
};
export type EditorLocaleReleaseApplyRequest = {
  confirmationToken: string;
  siteId: string;
  locale: LocalizationLocale;
  expectedCurrentVersion: string | null;
  optimisticVersion: string;
  preparedReleaseId: string;
  preparedVersion: string;
};
export type EditorLocaleReleaseApplyResult =
  | { status: "applied"; siteId: string; locale: LocalizationLocale; current: EditorLocaleReleaseSummary }
  | { status: "conflict" | "expired" };

/* ---------- ページ編集の言語全体の公開の parser（editor-locale-release.ts から移した） ---------- */

function bounded(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${name}`);
  return value;
}
function releaseSummary(input: unknown, name: string): EditorLocaleReleaseSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`invalid ${name}`);
  const source = input as Record<string, unknown>, allowed = ["releaseId", "version", "label", "publishedAt", "pages", "sharedResources"];
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw new Error(`invalid ${name}`);
  const publishedAt = bounded(source.publishedAt, `${name} publishedAt`, 40), parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== publishedAt) throw new Error(`invalid ${name}`);
  if (typeof source.pages !== "number" || !Number.isSafeInteger(source.pages) || source.pages < 0 || source.pages > 10_000 ||
    typeof source.sharedResources !== "number" || !Number.isSafeInteger(source.sharedResources) || source.sharedResources < 0 || source.sharedResources > 10_000) throw new Error(`invalid ${name}`);
  return { releaseId: bounded(source.releaseId, `${name} releaseId`), version: bounded(source.version, `${name} version`), label: bounded(source.label, `${name} label`, 300),
    publishedAt, pages: source.pages, sharedResources: source.sharedResources };
}
function reasons(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`invalid ${name}`);
  return value.map((entry) => bounded(entry, name, 500));
}
function releaseId(value: unknown, name: string): string {
  const result = bounded(value, name, 128);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(result)) throw new Error(`invalid ${name}`);
  return result;
}
function routePath(value: unknown): string {
  const path = bounded(value, "locale release path", 2048);
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/u.test(path)) throw new Error("invalid locale release path");
  let decoded: string; try { decoded = decodeURIComponent(path); } catch { throw new Error("invalid locale release path"); }
  if (decoded.slice(1).includes("//") || decoded.split("/").some((part) => part === "." || part === "..") || decoded.includes("\\") || /%2f|%5c/iu.test(path)) throw new Error("invalid locale release path");
  return path;
}

export function parseEditorLocaleReleaseState(input: unknown, siteId: string, locale: LocalizationLocale): EditorLocaleReleaseState {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locale release state");
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["siteId", "locale", "current", "history"].includes(key)) || source.siteId !== siteId || source.locale !== locale || !Array.isArray(source.history) || source.history.length > 1_000) throw new Error("invalid locale release state");
  const current = source.current === null ? null : releaseSummary(source.current, "current release"), history = source.history.map((entry, index) => releaseSummary(entry, `release history ${index}`));
  if (new Set(history.map((entry) => entry.releaseId)).size !== history.length || new Set(history.map((entry) => entry.version)).size !== history.length ||
    current && history.some((entry) => entry.releaseId === current.releaseId || entry.version === current.version)) throw new Error("invalid locale release history");
  return { siteId, locale, current, history };
}

export function parseEditorLocaleReleasePlan(input: unknown, request: EditorLocaleReleasePrepareRequest, allowedDomains?: readonly string[]): EditorLocaleReleasePlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locale release plan");
  const source = input as Record<string, unknown>, allowed = ["siteId", "locale", "action", "expectedSiteVersion", "expectedCurrentVersion", "rollbackReleaseId", "confirmationToken", "domain", "expiresAt", "optimisticVersion", "previous", "prepared", "pages", "sharedResources", "incompleteReasons", "complete"];
  if (Object.keys(source).some((key) => !allowed.includes(key)) || source.siteId !== request.siteId || source.locale !== request.locale || source.action !== request.action || source.expectedSiteVersion !== request.expectedSiteVersion ||
    source.expectedCurrentVersion !== request.expectedCurrentVersion || source.rollbackReleaseId !== request.rollbackReleaseId || !isSafeHttpsOrigin(source.domain) || allowedDomains && !allowedDomains.includes(source.domain)) throw new Error("locale release plan mismatch");
  const expiresAt = bounded(source.expiresAt, "release expiry", 40), expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= Date.now()) throw new Error("locale release plan expired");
  if (!Array.isArray(source.pages) || source.pages.length === 0 || source.pages.length > 10_000 || !Array.isArray(source.sharedResources) || source.sharedResources.length > 10_000 || typeof source.complete !== "boolean") throw new Error("invalid locale release plan details");
  const pages = source.pages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid locale release page"); const value = entry as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["pageId", "title", "path", "complete", "reasons"].includes(key)) || typeof value.complete !== "boolean") throw new Error("invalid locale release page");
    const itemReasons = reasons(value.reasons, `page reasons ${index}`);
    if (value.complete !== (itemReasons.length === 0)) throw new Error("locale release page completeness mismatch");
    return { pageId: releaseId(value.pageId, "pageId"), title: bounded(value.title, "page title", 300), path: routePath(value.path), complete: value.complete, reasons: itemReasons };
  });
  if (new Set(pages.map((entry) => entry.pageId)).size !== pages.length || new Set(pages.map((entry) => entry.path)).size !== pages.length) throw new Error("duplicate locale release page");
  const sharedResources = source.sharedResources.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid shared release resource"); const value = entry as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["id", "label", "kind", "complete", "reasons"].includes(key)) || !["component", "navigation", "style", "resource"].includes(String(value.kind)) || typeof value.complete !== "boolean") throw new Error("invalid shared release resource");
    const itemReasons = reasons(value.reasons, `shared reasons ${index}`);
    if (value.complete !== (itemReasons.length === 0)) throw new Error("shared release resource completeness mismatch");
    return { id: releaseId(value.id, "resource ID"), label: bounded(value.label, "resource label", 300), kind: value.kind as "component" | "navigation" | "style" | "resource", complete: value.complete, reasons: itemReasons };
  });
  if (new Set(sharedResources.map((entry) => entry.id)).size !== sharedResources.length) throw new Error("duplicate shared release resource");
  const incompleteReasons = reasons(source.incompleteReasons, "release reasons");
  if (source.complete !== (incompleteReasons.length === 0 && pages.every((entry) => entry.complete) && sharedResources.every((entry) => entry.complete))) throw new Error("release completeness mismatch");
  const previous = source.previous === null ? null : releaseSummary(source.previous, "previous release");
  if ((previous?.version ?? null) !== request.expectedCurrentVersion) throw new Error("previous locale release mismatch");
  const prepared = releaseSummary(source.prepared, "prepared release");
  if (prepared.pages !== pages.length || prepared.sharedResources !== sharedResources.length || previous && (prepared.releaseId === previous.releaseId || prepared.version === previous.version)) throw new Error("prepared locale release summary mismatch");
  return { ...request, confirmationToken: bounded(source.confirmationToken, "confirmation token", 512), domain: source.domain, expiresAt,
    optimisticVersion: bounded(source.optimisticVersion, "optimistic version"), previous, prepared, pages, sharedResources, incompleteReasons, complete: source.complete };
}

export function parseEditorLocaleReleaseApplyResult(input: unknown, expected: { siteId: string; locale: LocalizationLocale; prepared: Pick<EditorLocaleReleaseSummary, "releaseId" | "version"> & Partial<Omit<EditorLocaleReleaseSummary, "releaseId" | "version">> }): EditorLocaleReleaseApplyResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locale release result");
  const source = input as Record<string, unknown>;
  if (source.status === "conflict" || source.status === "expired") {
    if (Object.keys(source).some((key) => key !== "status")) throw new Error("invalid locale release result");
    return { status: source.status };
  }
  if (source.status !== "applied" || Object.keys(source).some((key) => !["status", "siteId", "locale", "current"].includes(key)) || source.siteId !== expected.siteId || source.locale !== expected.locale) throw new Error("invalid locale release result");
  const current = releaseSummary(source.current, "applied release");
  if (current.releaseId !== expected.prepared.releaseId || current.version !== expected.prepared.version ||
    expected.prepared.label !== undefined && current.label !== expected.prepared.label || expected.prepared.publishedAt !== undefined && current.publishedAt !== expected.prepared.publishedAt ||
    expected.prepared.pages !== undefined && current.pages !== expected.prepared.pages || expected.prepared.sharedResources !== undefined && current.sharedResources !== expected.prepared.sharedResources) throw new Error("applied locale release mismatch");
  return { status: "applied", siteId: expected.siteId, locale: expected.locale, current };
}

/* ---------- 翻訳の画面（LocalizationWorkspace）の言語全体の公開 ---------- */

/** 公開中・履歴の版。EditorLocaleReleaseSummary と同じ形。 */
export type LocaleReleaseSummary = EditorLocaleReleaseSummary;
/** その版を作った操作。 */
export type LocaleReleaseOperation = "publish" | "rollback";
export type LocaleReleaseHistoryEntry = LocaleReleaseSummary & {
  readonly operation: LocaleReleaseOperation;
  /** 操作した人（人が読む名前）。 */
  readonly by: string | null;
  /** この版に戻せるか。 */
  readonly restorable: boolean;
};
/** 準備・反映の進み具合。0 <= done <= total、total >= 1。 */
export type LocaleReleaseProgress = { readonly done: number; readonly total: number };
/** 途中で止まっている公開・戻し。resumeToken だけで続きから呼び直せる。 */
export type LocaleReleasePending = {
  readonly operation: LocaleReleaseOperation;
  readonly stage: "prepare" | "apply";
  readonly progress: LocaleReleaseProgress;
  readonly resumeToken: string;
  /** 戻しの行き先（公開は null）。 */
  readonly releaseId: string | null;
  readonly startedAt: string;
  readonly startedBy: string | null;
};
/** 公開できない理由。message はサイトが作る人が読む文。itemKey があれば画面から 1 件へ移れる。 */
export type LocaleReleaseBlocker = { readonly id: string; readonly message: string; readonly itemKey: string | null };
/** 公開で出る・外れるページ（人が読む題名とアドレス）。 */
export type LocaleReleasePageRef = { readonly path: string; readonly title: string };
/** 初回公開の確認に見せる内訳。自動訳の件数は未確認の自動訳を含むページ数。 */
export type LocaleFirstReleaseSummary = {
  readonly groups: readonly { readonly label: string; readonly pages: number; readonly automaticPages: number }[];
  readonly excluded: { readonly count: number; readonly examples: readonly (LocaleReleasePageRef & { readonly reason: string })[] };
};
export type LocaleReleaseWorkspacePlan = {
  readonly confirmationToken: string;
  readonly expiresAt: string;
  /** 公開する先（https の URL）。 */
  readonly address: string;
  readonly pages: number;
  readonly previous: LocaleReleaseSummary | null;
  readonly prepared: LocaleReleaseSummary;
  /** 確認済みのページだけを公開するサイトが返す、今の版から新しく出るページと外れるページ。返さないサイトは null。 */
  readonly changes: { readonly added: readonly LocaleReleasePageRef[]; readonly removed: readonly LocaleReleasePageRef[] } | null;
  /** 初回公開のときだけ。古い adapter は省略できる。 */
  readonly firstRelease: LocaleFirstReleaseSummary | null;
};
export type LocaleReleaseWorkspaceState = {
  readonly current: LocaleReleaseSummary | null;
  /** 新しい順。current と同じ版を含まない。 */
  readonly history: readonly LocaleReleaseHistoryEntry[];
  readonly pending: LocaleReleasePending | null;
};
export type LocaleReleasePrepareInput = {
  readonly operation: LocaleReleaseOperation;
  /** 戻しの行き先（公開は null）。 */
  readonly releaseId: string | null;
  /** overview.version。 */
  readonly expectedVersion: string;
  readonly expectedCurrentVersion: string | null;
  readonly resumeToken: string | null;
};
/** confirmationToken と resumeToken は、どちらか 1 つだけが文字列。 */
export type LocaleReleaseApplyInput = { readonly confirmationToken: string | null; readonly resumeToken: string | null };
export type LocaleReleaseForbidden = { readonly status: "forbidden" };
export type LocaleReleaseStateResult = ({ readonly status: "ready" } & LocaleReleaseWorkspaceState) | LocaleReleaseForbidden;
export type LocaleReleasePrepareResult =
  | { readonly status: "preparing"; readonly progress: LocaleReleaseProgress; readonly resumeToken: string }
  | { readonly status: "ready"; readonly plan: LocaleReleaseWorkspacePlan }
  | { readonly status: "blocked"; readonly blockers: readonly LocaleReleaseBlocker[] }
  | { readonly status: "conflict" }
  | LocaleReleaseForbidden;
export type LocaleReleaseApplyResult =
  | { readonly status: "applying"; readonly progress: LocaleReleaseProgress; readonly resumeToken: string }
  | { readonly status: "applied"; readonly current: LocaleReleaseSummary }
  | { readonly status: "expired" | "conflict" }
  | LocaleReleaseForbidden;

const RELEASE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,512}$/u;
const ITEM_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/u;
const BLOCKER_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u;

function oneLine(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid text");
  return value;
}
function nullableName(value: unknown, path: string): string | null {
  return value === null ? null : oneLine(value, path, 200);
}
function exactIso(value: unknown, path: string): string {
  const text = oneLine(value, path, 40), parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) fail(path, "expected an ISO timestamp (UTC, milliseconds)");
  return text;
}
function count(value: unknown, path: string, max = 10_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(path, "expected a bounded count");
  return value;
}
/** 版の識別子（releaseId）。 */
export function parseLocaleReleaseId(value: unknown, path: string): string {
  if (typeof value !== "string" || !RELEASE_ID_RE.test(value)) fail(path, "invalid release ID");
  return value;
}
/** 確認・再開の token。URL・ログに出さない不透明な文字列。 */
export function parseLocaleReleaseToken(value: unknown, path: string): string {
  if (typeof value !== "string" || !TOKEN_RE.test(value)) fail(path, "invalid token");
  return value;
}
export function parseLocaleReleaseSummary(input: unknown, path = "release"): LocaleReleaseSummary {
  const source = record(input, path);
  keys(source, ["releaseId", "version", "label", "publishedAt", "pages", "sharedResources"], path);
  return {
    releaseId: parseLocaleReleaseId(source.releaseId, `${path}.releaseId`), version: oneLine(source.version, `${path}.version`, 200),
    label: oneLine(source.label, `${path}.label`, 300), publishedAt: exactIso(source.publishedAt, `${path}.publishedAt`),
    pages: count(source.pages, `${path}.pages`), sharedResources: count(source.sharedResources, `${path}.sharedResources`),
  };
}
function operation(value: unknown, path: string): LocaleReleaseOperation {
  if (value !== "publish" && value !== "rollback") fail(path, "invalid operation");
  return value;
}
export function parseLocaleReleaseProgress(input: unknown, path = "progress"): LocaleReleaseProgress {
  const source = record(input, path);
  keys(source, ["done", "total"], path);
  const total = count(source.total, `${path}.total`, 1_000_000), done = count(source.done, `${path}.done`, 1_000_000);
  if (total < 1 || done > total) fail(path, "progress out of range");
  return { done, total };
}
export function parseLocaleReleaseHistoryEntry(input: unknown, path = "history"): LocaleReleaseHistoryEntry {
  const source = record(input, path);
  keys(source, ["releaseId", "version", "label", "publishedAt", "pages", "sharedResources", "operation", "by", "restorable"], path);
  const { operation: rawOperation, by, restorable, ...summary } = source;
  if (typeof restorable !== "boolean") fail(`${path}.restorable`, "expected a boolean");
  return { ...parseLocaleReleaseSummary(summary, path), operation: operation(rawOperation, `${path}.operation`), by: nullableName(by, `${path}.by`), restorable };
}
export function parseLocaleReleasePending(input: unknown, path = "pending"): LocaleReleasePending {
  const source = record(input, path);
  keys(source, ["operation", "stage", "progress", "resumeToken", "releaseId", "startedAt", "startedBy"], path);
  if (source.stage !== "prepare" && source.stage !== "apply") fail(`${path}.stage`, "invalid stage");
  const kind = operation(source.operation, `${path}.operation`);
  const releaseId = source.releaseId === null ? null : parseLocaleReleaseId(source.releaseId, `${path}.releaseId`);
  if ((kind === "rollback") !== (releaseId !== null)) fail(`${path}.releaseId`, "rollback needs a release ID and publish has none");
  const startedAt = oneLine(source.startedAt, `${path}.startedAt`, 40);
  if (!Number.isFinite(Date.parse(startedAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(startedAt)) fail(`${path}.startedAt`, "expected an ISO timestamp with timezone");
  return {
    operation: kind, stage: source.stage, progress: parseLocaleReleaseProgress(source.progress, `${path}.progress`),
    resumeToken: parseLocaleReleaseToken(source.resumeToken, `${path}.resumeToken`), releaseId, startedAt, startedBy: nullableName(source.startedBy, `${path}.startedBy`),
  };
}
export function parseLocaleReleaseBlocker(input: unknown, path = "blocker"): LocaleReleaseBlocker {
  const source = record(input, path);
  keys(source, ["id", "message", "itemKey"], path);
  if (typeof source.id !== "string" || !BLOCKER_ID_RE.test(source.id)) fail(`${path}.id`, "invalid blocker ID");
  if (source.itemKey !== null && (typeof source.itemKey !== "string" || !ITEM_KEY_RE.test(source.itemKey))) fail(`${path}.itemKey`, "invalid item key");
  return { id: source.id, message: oneLine(source.message, `${path}.message`, 400), itemKey: source.itemKey as string | null };
}
export function parseLocaleReleaseBlockers(input: unknown, path = "blockers"): LocaleReleaseBlocker[] {
  if (!Array.isArray(input) || input.length > 200) fail(path, "expected a bounded array");
  const blockers = input.map((entry, index) => parseLocaleReleaseBlocker(entry, `${path}[${index}]`));
  if (new Set(blockers.map((entry) => entry.id)).size !== blockers.length) fail(path, "duplicate blocker");
  return blockers;
}
function forbidden(source: Record<string, unknown>, path: string): LocaleReleaseForbidden | null {
  if (source.status !== "forbidden") return null;
  keys(source, ["status"], path);
  return { status: "forbidden" };
}

export function parseLocaleReleaseStateResult(input: unknown): LocaleReleaseStateResult {
  const source = record(input, "release");
  const denied = forbidden(source, "release");
  if (denied) return denied;
  keys(source, ["status", "current", "history", "pending"], "release");
  if (source.status !== "ready") fail("release.status", "invalid status");
  const current = source.current === null ? null : parseLocaleReleaseSummary(source.current, "release.current");
  if (!Array.isArray(source.history) || source.history.length > 1_000) fail("release.history", "expected a bounded array");
  const history = source.history.map((entry, index) => parseLocaleReleaseHistoryEntry(entry, `release.history[${index}]`));
  const ids = new Set(history.map((entry) => entry.releaseId)), versions = new Set(history.map((entry) => entry.version));
  if (ids.size !== history.length || versions.size !== history.length || current && (ids.has(current.releaseId) || versions.has(current.version))) fail("release.history", "duplicate release");
  const pending = source.pending === null ? null : parseLocaleReleasePending(source.pending, "release.pending");
  return { status: "ready", current, history, pending };
}

export function parseLocaleReleasePrepareResult(input: unknown, request: LocaleReleasePrepareInput): LocaleReleasePrepareResult {
  const source = record(input, "prepare");
  const denied = forbidden(source, "prepare");
  if (denied) return denied;
  if (source.status === "conflict") { keys(source, ["status"], "prepare"); return { status: "conflict" }; }
  if (source.status === "preparing") {
    keys(source, ["status", "progress", "resumeToken"], "prepare");
    return { status: "preparing", progress: parseLocaleReleaseProgress(source.progress, "prepare.progress"), resumeToken: parseLocaleReleaseToken(source.resumeToken, "prepare.resumeToken") };
  }
  if (source.status === "blocked") {
    keys(source, ["status", "blockers"], "prepare");
    const blockers = parseLocaleReleaseBlockers(source.blockers, "prepare.blockers");
    if (!blockers.length) fail("prepare.blockers", "blocked needs at least one reason");
    return { status: "blocked", blockers };
  }
  keys(source, ["status", "plan"], "prepare");
  if (source.status !== "ready") fail("prepare.status", "invalid status");
  const plan = record(source.plan, "prepare.plan");
  keys(plan, ["confirmationToken", "expiresAt", "address", "pages", "previous", "prepared", "changes", "firstRelease"], "prepare.plan");
  const address = oneLine(plan.address, "prepare.plan.address", 2048);
  let url: URL;
  try { url = new URL(address); } catch { fail("prepare.plan.address", "invalid address"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || url.search) fail("prepare.plan.address", "address must be an https URL without query or fragment");
  const previous = plan.previous === null ? null : parseLocaleReleaseSummary(plan.previous, "prepare.plan.previous");
  if ((previous?.version ?? null) !== request.expectedCurrentVersion) fail("prepare.plan.previous", "previous release mismatch");
  const prepared = parseLocaleReleaseSummary(plan.prepared, "prepare.plan.prepared");
  if (previous && (prepared.releaseId === previous.releaseId || prepared.version === previous.version)) fail("prepare.plan.prepared", "prepared release equals the current one");
  if (request.operation === "rollback" && prepared.releaseId !== request.releaseId) fail("prepare.plan.prepared", "rollback target mismatch");
  const expiresAt = exactIso(plan.expiresAt, "prepare.plan.expiresAt");
  const firstRelease = plan.firstRelease === undefined || plan.firstRelease === null ? null : parseFirstRelease(plan.firstRelease, count(plan.pages, "prepare.plan.pages"));
  if (firstRelease && (request.operation !== "publish" || previous !== null)) fail("prepare.plan.firstRelease", "only first publication has a summary");
  return {
    status: "ready",
    plan: { confirmationToken: parseLocaleReleaseToken(plan.confirmationToken, "prepare.plan.confirmationToken"), expiresAt, address, pages: count(plan.pages, "prepare.plan.pages"), previous, prepared,
      changes: plan.changes === undefined || plan.changes === null ? null : parsePageChanges(plan.changes, "prepare.plan.changes"), firstRelease },
  };
}
function parseFirstRelease(input: unknown, pages: number): LocaleFirstReleaseSummary {
  const path = "prepare.plan.firstRelease", source = record(input, path);
  keys(source, ["groups", "excluded"], path);
  if (!Array.isArray(source.groups) || source.groups.length === 0 || source.groups.length > 100) fail(`${path}.groups`, "expected a bounded list of groups");
  const groups = source.groups.map((entry, index) => {
    const at = `${path}.groups[${index}]`, group = record(entry, at);
    keys(group, ["label", "pages", "automaticPages"], at);
    const countPages = count(group.pages, `${at}.pages`), automaticPages = count(group.automaticPages, `${at}.automaticPages`);
    if (countPages === 0 || automaticPages > countPages) fail(at, "invalid group count");
    return { label: oneLine(group.label, `${at}.label`, 100), pages: countPages, automaticPages };
  });
  if (new Set(groups.map((group) => group.label)).size !== groups.length || groups.reduce((sum, group) => sum + group.pages, 0) !== pages) fail(`${path}.groups`, "groups do not match pages");
  const excluded = record(source.excluded, `${path}.excluded`);
  keys(excluded, ["count", "examples"], `${path}.excluded`);
  const excludedCount = count(excluded.count, `${path}.excluded.count`);
  if (!Array.isArray(excluded.examples) || excluded.examples.length > 20 || excluded.examples.length > excludedCount) fail(`${path}.excluded.examples`, "expected a bounded list of excluded pages");
  const examples = excluded.examples.map((entry, index) => {
    const at = `${path}.excluded.examples[${index}]`, page = record(entry, at);
    keys(page, ["path", "title", "reason"], at);
    return { path: routePath(page.path), title: oneLine(page.title, `${at}.title`, 200), reason: oneLine(page.reason, `${at}.reason`, 200) };
  });
  if (new Set(examples.map((page) => page.path)).size !== examples.length) fail(`${path}.excluded.examples`, "duplicate page");
  return { groups, excluded: { count: excludedCount, examples } };
}
const PAGE_CHANGES_MAX = 500;
function parsePageChanges(input: unknown, path: string): NonNullable<LocaleReleaseWorkspacePlan["changes"]> {
  const source = record(input, path);
  keys(source, ["added", "removed"], path);
  const list = (value: unknown, at: string) => {
    if (!Array.isArray(value) || value.length > PAGE_CHANGES_MAX) fail(at, "expected a bounded list of pages");
    const pages = value.map((entry, index) => {
      const page = record(entry, `${at}[${index}]`);
      keys(page, ["path", "title"], `${at}[${index}]`);
      const pagePath = oneLine(page.path, `${at}[${index}].path`, 2048);
      if (!pagePath.startsWith("/") || pagePath.startsWith("//")) fail(`${at}[${index}].path`, "expected a site path");
      return { path: pagePath, title: oneLine(page.title, `${at}[${index}].title`, 200) };
    });
    if (new Set(pages.map((page) => page.path)).size !== pages.length) fail(at, "duplicate page");
    return pages;
  };
  const added = list(source.added, `${path}.added`), removed = list(source.removed, `${path}.removed`);
  if (added.some((page) => removed.some((other) => other.path === page.path))) fail(path, "a page is both added and removed");
  return { added, removed };
}

export function parseLocaleReleaseApplyResult(input: unknown, expected: { readonly prepared: Pick<LocaleReleaseSummary, "releaseId" | "version"> | null }): LocaleReleaseApplyResult {
  const source = record(input, "apply");
  const denied = forbidden(source, "apply");
  if (denied) return denied;
  if (source.status === "expired" || source.status === "conflict") { keys(source, ["status"], "apply"); return { status: source.status }; }
  if (source.status === "applying") {
    keys(source, ["status", "progress", "resumeToken"], "apply");
    return { status: "applying", progress: parseLocaleReleaseProgress(source.progress, "apply.progress"), resumeToken: parseLocaleReleaseToken(source.resumeToken, "apply.resumeToken") };
  }
  keys(source, ["status", "current"], "apply");
  if (source.status !== "applied") fail("apply.status", "invalid status");
  const current = parseLocaleReleaseSummary(source.current, "apply.current");
  if (expected.prepared && (current.releaseId !== expected.prepared.releaseId || current.version !== expected.prepared.version)) fail("apply.current", "applied release mismatch");
  return { status: "applied", current };
}
