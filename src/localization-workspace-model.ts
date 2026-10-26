/**
 * 翻訳の画面（LocalizationWorkspace）の契約の型・runtime parser・印（置き換えてはいけない部分）の扱い。React 不要。
 * 契約の正: docs/localization-workspace-contract.md
 */
import { isDisplayableImageUrl, isIsoTimestamp } from "./collection-model.js";
import { parseLocalizationValue } from "./localization.js";
import type { LocalizationLocale, LocalizationUnitState, LocalizedAsset, LocalizedRichText, LocalizedRichTextNode } from "./localization-types.js";
import {
  parseLocaleReleaseBlockers, parseLocaleReleasePending, parseLocaleReleaseProgress, parseLocaleReleaseSummary,
  type LocaleReleaseApplyInput, type LocaleReleaseBlocker, type LocaleReleasePending, type LocaleReleasePrepareInput, type LocaleReleaseProgress,
  type LocaleReleaseSummary,
} from "./locale-release-contract.js";
import { DocumentValidationError, fail, keys, record } from "./validation-utils.js";

export type {
  LocaleReleaseApplyInput, LocaleReleaseApplyResult, LocaleReleaseBlocker, LocaleReleaseHistoryEntry, LocaleReleaseOperation, LocaleReleasePending,
  LocaleReleasePrepareInput, LocaleReleasePrepareResult, LocaleReleaseProgress, LocaleReleaseStateResult, LocaleReleaseSummary, LocaleReleaseWorkspacePlan,
  LocaleReleaseWorkspaceState,
} from "./locale-release-contract.js";
export {
  parseLocaleReleaseApplyResult, parseLocaleReleaseBlockers, parseLocaleReleaseHistoryEntry, parseLocaleReleasePending, parseLocaleReleasePrepareResult,
  parseLocaleReleaseProgress, parseLocaleReleaseStateResult, parseLocaleReleaseSummary,
} from "./locale-release-contract.js";
export type { LocalizationLocale, LocalizationUnitState, LocalizedAsset, LocalizedRichText, LocalizedRichTextNode } from "./localization-types.js";

/* ---------- 型 ---------- */

export type LocalizationPermission = "edit" | "review" | "translate" | "publish" | "rollback" | "settings";
export const LOCALIZATION_PERMISSIONS: readonly LocalizationPermission[] = ["edit", "review", "translate", "publish", "rollback", "settings"];
export type LocalizationGroup = {
  readonly id: string; readonly label: string;
  readonly items: number; readonly needsWork: number; readonly reviewed: number; readonly excluded: number;
};
export type LocalizationSettings = {
  readonly version: string;
  /** 原文が変わったら翻訳案を自動で作るか。画面で変えられるのはこれだけ。 */
  readonly autoDraft: boolean;
  readonly translator: { readonly connected: boolean };
  readonly queue: { readonly waiting: number; readonly failed: number; readonly nextRetryAt: string | null };
};
export type LocalizationCatalog = { readonly state: "current" } | { readonly state: "updating"; readonly progress: LocaleReleaseProgress };
export type LocalizationOverview = {
  readonly version: string;
  readonly sourceLocale: LocalizationLocale;
  readonly targetLocale: LocalizationLocale;
  /** 人が読む言語名（例 日本語 / English）。 */
  readonly languages: { readonly source: string; readonly target: string };
  readonly permissions: readonly LocalizationPermission[];
  readonly groups: readonly LocalizationGroup[];
  readonly release: { readonly current: LocaleReleaseSummary | null; readonly pending: LocaleReleasePending | null };
  readonly blockers: readonly LocaleReleaseBlocker[];
  readonly catalog: LocalizationCatalog;
  readonly preview: { readonly frameUrl: string } | null;
  readonly settings: LocalizationSettings;
};

/** untranslated・draft・source-changed は「要対応」。 */
export type LocalizationItemState = "untranslated" | "draft" | "source-changed" | "reviewed" | "excluded";
export type LocalizationItemSummary = {
  readonly key: string;
  readonly groupId: string;
  readonly title: string;
  readonly path: string | null;
  /** 1 行にまとめた内容の、人が読む短い名前。古い adapter は省略できる。 */
  readonly includedParts?: readonly string[];
  readonly state: LocalizationItemState;
  readonly excludedReason: string | null;
  /** 確認済み n/m の m（訳す項目の数）。 */
  readonly totalUnits: number;
  readonly reviewedUnits: number;
  readonly imagesUnreviewed: number;
  readonly sourceDraftPending: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
};
export type LocalizationTextMark = { readonly id: string; readonly label: string };
/** asset は niho-web の LocalizedAsset（set-image でそのまま送る）。url は表示用。 */
export type LocalizationImage = { readonly asset: LocalizedAsset; readonly url: string };
export type LocalizationEditOrigin = "AUTO" | "MANUAL";
type UnitBase = {
  readonly unitId: string;
  readonly label: string;
  readonly section: string | null;
  readonly required: boolean;
  /** 項目の版（CAS）。 */
  readonly version: string;
  /** 原文の版（CAS）。 */
  readonly sourceVersion: string;
  readonly state: LocalizationUnitState;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
};
export type LocalizationTextUnit = UnitBase & {
  readonly kind: "text";
  /** 保存済み訳文の出どころ。古い adapter は省略できる。 */
  readonly editOrigin?: LocalizationEditOrigin | null;
  readonly source: string; readonly value: string | null; readonly previousSource: string | null;
  readonly candidate: { readonly candidateId: string; readonly value: string } | null;
  readonly marks: readonly LocalizationTextMark[];
  /** 印を除いた文字の数（コードポイント）の上限。 */
  readonly maxLength: number | null;
  readonly singleLine: boolean;
};
export type LocalizationRichTextUnit = UnitBase & {
  readonly kind: "rich-text";
  /** 保存済み訳文の出どころ。古い adapter は省略できる。 */
  readonly editOrigin?: LocalizationEditOrigin | null;
  readonly source: LocalizedRichText; readonly value: LocalizedRichText | null; readonly previousSource: LocalizedRichText | null;
  readonly candidate: { readonly candidateId: string; readonly value: LocalizedRichText } | null;
};
export type LocalizationImageUnit = UnitBase & { readonly kind: "image"; readonly source: LocalizationImage; readonly value: LocalizationImage | null };
export type LocalizationWorkspaceUnit = LocalizationTextUnit | LocalizationRichTextUnit | LocalizationImageUnit;
export type LocalizationJob = { readonly jobId: string; readonly state: "queued" | "running" | "done" | "failed"; readonly message: string | null };
export type LocalizationPreviewChoice = { readonly id: string; readonly label: string };
export type LocalizationItem = LocalizationItemSummary & {
  readonly units: readonly LocalizationWorkspaceUnit[];
  readonly previews: readonly LocalizationPreviewChoice[];
  readonly job: LocalizationJob | null;
};

export type LocalizationForbidden = { readonly status: "forbidden" };
export type LocalizationNotFound = { readonly status: "not_found" };
export type LocalizationInvalid = { readonly status: "invalid"; readonly message: string };
export type LocalizationOverviewResult = { readonly status: "ready"; readonly overview: LocalizationOverview } | LocalizationForbidden;
export type LocalizationListResult = { readonly status: "ready"; readonly items: readonly LocalizationItemSummary[]; readonly nextCursor: string | null } | LocalizationForbidden;
export type LocalizationItemResult = { readonly status: "ready"; readonly item: LocalizationItem } | LocalizationNotFound | LocalizationForbidden;
export type LocalizationCommandResult =
  | { readonly status: "applied" | "conflict"; readonly unit: LocalizationWorkspaceUnit; readonly summary: LocalizationItemSummary }
  | LocalizationInvalid | LocalizationNotFound | LocalizationForbidden;
export type LocalizationTranslationResult = { readonly status: "queued"; readonly job: LocalizationJob } | LocalizationInvalid | LocalizationNotFound | LocalizationForbidden;
export type LocalizationJobResult = { readonly status: "ready"; readonly job: LocalizationJob } | LocalizationNotFound | LocalizationForbidden;
export type LocalizationCatalogResult = { readonly status: "updating"; readonly progress: LocaleReleaseProgress } | { readonly status: "current" } | LocalizationForbidden;
export type LocalizationPreviewResult = { readonly status: "ready"; readonly material: unknown; readonly nextCursor: string | null } | LocalizationNotFound | LocalizationForbidden;
export type LocalizationSettingsResult = { readonly status: "saved" | "conflict"; readonly settings: LocalizationSettings } | LocalizationInvalid | LocalizationForbidden;
export type LocalizationImageRejectReason = "type" | "size" | "permission" | "invalid";
export type LocalizationImageResult =
  | { readonly status: "uploaded" | "picked"; readonly image: LocalizationImage }
  | { readonly status: "rejected"; readonly reason: LocalizationImageRejectReason }
  | { readonly status: "cancelled" };

type CommandBase = {
  readonly itemKey: string; readonly operationId: string; readonly unitId: string;
  /** 画面が直し始めたときの項目の版。 */
  readonly expectedVersion: string;
  /** 画面が見ていた原文の版。 */
  readonly expectedSourceVersion: string;
};
export type LocalizationCommandInput = CommandBase & (
  | { readonly action: "set-value"; readonly value: string | LocalizedRichText }
  | { readonly action: "adopt-candidate"; readonly candidateId: string }
  | { readonly action: "review-current" }
  | { readonly action: "clear-value" }
  | { readonly action: "set-image"; readonly image: LocalizedAsset | null }
  | { readonly action: "review-image" }
);
export type LocalizationCommandAction = LocalizationCommandInput["action"];

/**
 * サイトが実装する adapter。戻り値は unknown として受け取り、parser で確かめる。
 * 認証・認可・保存・CAS・翻訳サービス・公開・描画の中身はサイトの責務。
 */
export interface LocalizationWorkspaceAdapter {
  loadOverview(signal: AbortSignal): Promise<unknown>;
  listItems(input: { readonly cursor: string | null }, signal: AbortSignal): Promise<unknown>;
  loadItem(input: { readonly itemKey: string }, signal: AbortSignal): Promise<unknown>;
  command(input: LocalizationCommandInput, signal: AbortSignal): Promise<unknown>;
  requestTranslation(input: { readonly itemKey: string; readonly operationId: string; readonly unitIds: readonly string[] | null }, signal: AbortSignal): Promise<unknown>;
  readJob(input: { readonly jobId: string }, signal: AbortSignal): Promise<unknown>;
  advanceCatalog(input: Record<string, never>, signal: AbortSignal): Promise<unknown>;
  loadPreview(input: { readonly itemKey: string; readonly previewId: string; readonly cursor: string | null }, signal: AbortSignal): Promise<unknown>;
  readRelease(signal: AbortSignal): Promise<unknown>;
  prepareRelease(input: LocaleReleasePrepareInput, signal: AbortSignal): Promise<unknown>;
  applyRelease(input: LocaleReleaseApplyInput, signal: AbortSignal): Promise<unknown>;
  saveSettings(input: { readonly expectedVersion: string; readonly autoDraft: boolean }, signal: AbortSignal): Promise<unknown>;
  /** 任意。訳す言語の画像を上げる。 */
  uploadImage?(input: { readonly itemKey: string; readonly unitId: string; readonly file: File }, signal: AbortSignal): Promise<unknown>;
  /** 任意。ホストの素材の選び方の画面を出し、選んだ画像を返す。 */
  pickAsset?(input: { readonly itemKey: string; readonly unitId: string }, signal: AbortSignal): Promise<unknown>;
  /** 任意（同期）。原文を CMS で開く URL（https か "/" から始まる同じサイトの path）。null なら出さない。 */
  sourceLink?(itemKey: string): string | null;
  /** 任意（同期）。その項目のサブ言語の編集画面への URL。null ならこの画面で項目を開く。 */
  editLink?(itemKey: string): string | null;
}

/* ---------- 上限と小さな検証 ---------- */

export const LOCALIZATION_LIMITS = {
  listPage: 500, listPages: 100, units: 2000, text: 100_000, marks: 200, groups: 50, previews: 50,
  previewBytes: 2 * 1024 * 1024, previewParts: 40, previewTotalBytes: 16 * 1024 * 1024,
} as const;
const ITEM_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/u;
const UNIT_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,299}$/u;
const SHORT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u;
const MARK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/u;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/u;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/u;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

function pattern(value: unknown, re: RegExp, path: string, reason: string): string {
  if (typeof value !== "string" || !re.test(value) || RESERVED.has(value)) fail(path, reason);
  return value;
}
export const isLocalizationItemKey = (value: unknown): value is string => typeof value === "string" && ITEM_KEY_RE.test(value) && !RESERVED.has(value);
export const isLocalizationOperationId = (value: unknown): value is string => typeof value === "string" && OPERATION_ID_RE.test(value);
const itemKey = (value: unknown, path: string) => pattern(value, ITEM_KEY_RE, path, "invalid item key");
const unitId = (value: unknown, path: string) => pattern(value, UNIT_ID_RE, path, "invalid unit ID");
const shortId = (value: unknown, path: string) => pattern(value, SHORT_ID_RE, path, "invalid ID");
const cursor = (value: unknown, path: string) => value === null ? null : pattern(value, CURSOR_RE, path, "invalid cursor");
/** 1 行・空でない・制御文字なし。 */
function name(value: unknown, path: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid text");
  return value;
}
const nullableName = (value: unknown, path: string, max = 200) => value === null ? null : name(value, path, max);
/** 1 行（空でもよい）。 */
function lineText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid text");
  return value;
}
const version = (value: unknown, path: string) => name(value, path, 200);
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}
function count(value: unknown, path: string, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(path, "expected a bounded count");
  return value;
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, "expected a bounded array");
  return value;
}
function timestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (!isIsoTimestamp(value)) fail(path, "expected an ISO timestamp with timezone");
  return value;
}
function sitePath(value: unknown, path: string): string | null {
  if (value === null) return null;
  const text = lineText(value, path, 2048);
  if (!text.startsWith("/") || text.startsWith("//") || /[\s\\]/u.test(text)) fail(path, "path must start with /");
  return text;
}
/** 遷移に使ってよい URL（https の絶対 URL、または "/" から始まる同じサイトの path）。 */
export function isSafeNavigationUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
/** プレビューの枠の URL（https。開発用に http の localhost・127.0.0.1 も可。fragment・資格情報なし）。 */
export function isPreviewFrameUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (url.protocol === "https:" || local) && !!url.hostname && !url.username && !url.password && !url.hash && !value.includes("#");
  } catch { return false; }
}
function forbiddenOr(source: Record<string, unknown>, path: string, allowNotFound: boolean): LocalizationForbidden | LocalizationNotFound | null {
  if (source.status === "forbidden" || allowNotFound && source.status === "not_found") { keys(source, ["status"], path); return { status: source.status }; }
  return null;
}
function invalid(source: Record<string, unknown>, path: string): LocalizationInvalid {
  keys(source, ["status", "message"], path);
  return { status: "invalid", message: name(source.message, `${path}.message`, 400) };
}

/* ---------- 印（⟦id⟧）とリッチテキストの札 ---------- */

/** 文字の値の中の印。U+27E6 と U+27E7 で囲んだ id。 */
export const MARK_TOKEN = /\u27e6([A-Za-z0-9_-]{1,32})\u27e7/gu;
export const markToken = (id: string) => `\u27e6${id}\u27e7`;
/** 編集の単位。text は文字、mark は札（single = 文字の印・改行、open/close = リッチテキストの要素の始まりと終わり）。 */
export type MarkSegment = { readonly type: "text"; readonly text: string } | { readonly type: "mark"; readonly id: string; readonly edge: "single" | "open" | "close" };

/** 文字の値を、文字と札の並びにする。 */
export function textSegments(value: string): MarkSegment[] {
  const result: MarkSegment[] = [];
  let last = 0;
  for (const match of value.matchAll(MARK_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) result.push({ type: "text", text: value.slice(last, index) });
    result.push({ type: "mark", id: match[1]!, edge: "single" });
    last = index + match[0].length;
  }
  if (last < value.length) result.push({ type: "text", text: value.slice(last) });
  return result;
}
/** 文字と札の並びを、文字の値（印は ⟦id⟧）に戻す。 */
export function segmentsToText(segments: readonly MarkSegment[]): string {
  return segments.map((segment) => segment.type === "text" ? segment.text : markToken(segment.id)).join("");
}
/** 印の id ごとの数。 */
export function markCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of value.matchAll(MARK_TOKEN)) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  return counts;
}
/** 印を除いた文字の数（コードポイント）。 */
export function visibleLength(value: string): number {
  return [...value.replace(MARK_TOKEN, "")].length;
}

export type MarkProblem = { readonly kind: "missing" | "extra" | "unknown" | "order"; readonly ids: readonly string[] };
/** 訳文の札が原文の印と一対一か。合わなければ問題を返す。 */
export function checkTextMarks(value: string, marks: readonly LocalizationTextMark[]): MarkProblem | null {
  const counts = markCounts(value), known = new Set(marks.map((mark) => mark.id));
  const unknown = [...counts.keys()].filter((id) => !known.has(id));
  if (unknown.length) return { kind: "unknown", ids: unknown };
  const missing = marks.filter((mark) => !counts.has(mark.id)).map((mark) => mark.id);
  if (missing.length) return { kind: "missing", ids: missing };
  const extra = marks.filter((mark) => (counts.get(mark.id) ?? 0) > 1).map((mark) => mark.id);
  return extra.length ? { kind: "extra", ids: extra } : null;
}

const RICH_LABELS: Readonly<Record<string, string>> = { a: "リンク", strong: "太字", b: "太字", em: "斜体", i: "斜体", small: "小さい文字", span: "文字の飾り", br: "改行" };
export type RichMarkInfo = { readonly id: string; readonly tag: string; readonly parent: string; readonly label: string };
/** 原文のリッチテキストの要素（札）の一覧。label は人が読む名前（リンク・太字など）。 */
export function richMarks(source: LocalizedRichText): RichMarkInfo[] {
  const result: RichMarkInfo[] = [];
  const visit = (nodes: readonly LocalizedRichTextNode[], parent: string) => {
    for (const node of nodes) {
      if (node.type === "text") continue;
      result.push({ id: node.id, tag: node.tag, parent, label: RICH_LABELS[node.tag] ?? "飾り" });
      visit(node.children, node.id);
    }
  };
  visit(source.children, "$root");
  return result;
}
/** リッチテキストを、文字と対の札の並びにする（br は 1 つの札）。 */
export function richSegments(value: LocalizedRichText): MarkSegment[] {
  const result: MarkSegment[] = [];
  const pushText = (text: string) => {
    const last = result.at(-1);
    if (last?.type === "text") result[result.length - 1] = { type: "text", text: last.text + text };
    else if (text) result.push({ type: "text", text });
  };
  const visit = (nodes: readonly LocalizedRichTextNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") pushText(node.text);
      else if (node.tag === "br") result.push({ type: "mark", id: node.id, edge: "single" });
      else { result.push({ type: "mark", id: node.id, edge: "open" }); visit(node.children); result.push({ type: "mark", id: node.id, edge: "close" }); }
    }
  };
  visit(value.children);
  return result;
}
/** 札の並びをリッチテキストに戻す。札の数・対・入れ子が原文と合わなければ問題を返す。 */
export function segmentsToRichText(segments: readonly MarkSegment[], source: LocalizedRichText): { readonly value: LocalizedRichText } | { readonly problem: MarkProblem } {
  const info = new Map(richMarks(source).map((mark) => [mark.id, mark]));
  const seen = new Map<string, number>();
  for (const segment of segments) if (segment.type === "mark" && segment.edge !== "close") seen.set(segment.id, (seen.get(segment.id) ?? 0) + 1);
  const unknown = [...seen.keys()].filter((id) => !info.has(id));
  for (const segment of segments) if (segment.type === "mark" && segment.edge === "close" && !info.has(segment.id) && !unknown.includes(segment.id)) unknown.push(segment.id);
  if (unknown.length) return { problem: { kind: "unknown", ids: unknown } };
  const missing = [...info.keys()].filter((id) => !seen.has(id));
  const closes = new Map<string, number>();
  for (const segment of segments) if (segment.type === "mark" && segment.edge === "close") closes.set(segment.id, (closes.get(segment.id) ?? 0) + 1);
  for (const [id, mark] of info) if (mark.tag !== "br" && !closes.has(id) && !missing.includes(id)) missing.push(id);
  if (missing.length) return { problem: { kind: "missing", ids: missing } };
  const extra = [...info.keys()].filter((id) => (seen.get(id) ?? 0) > 1 || (closes.get(id) ?? 0) > 1);
  if (extra.length) return { problem: { kind: "extra", ids: extra } };
  type Frame = { id: string; children: LocalizedRichTextNode[] };
  const root: Frame = { id: "$root", children: [] }, stack: Frame[] = [root];
  for (const segment of segments) {
    const top = stack.at(-1)!;
    if (segment.type === "text") {
      if (!segment.text) continue;
      const last = top.children.at(-1);
      if (last?.type === "text") top.children[top.children.length - 1] = { type: "text", text: last.text + segment.text };
      else top.children.push({ type: "text", text: segment.text });
      continue;
    }
    const mark = info.get(segment.id)!;
    const isVoid = mark.tag === "br";
    if (isVoid !== (segment.edge === "single") || mark.parent !== top.id && segment.edge !== "close") return { problem: { kind: "order", ids: [segment.id] } };
    if (segment.edge === "single") { top.children.push({ type: "element", id: mark.id, tag: mark.tag as "br", children: [] }); continue; }
    if (segment.edge === "open") {
      const frame: Frame = { id: mark.id, children: [] };
      top.children.push({ type: "element", id: mark.id, tag: mark.tag as Exclude<LocalizedRichTextNode, { type: "text" }>["tag"], children: frame.children });
      stack.push(frame);
      continue;
    }
    if (top.id !== segment.id) return { problem: { kind: "order", ids: [segment.id] } };
    stack.pop();
  }
  if (stack.length !== 1) return { problem: { kind: "order", ids: [stack.at(-1)!.id] } };
  return { value: { kind: "rich-text", children: root.children } };
}
/** リッチテキストの文字だけ（札を除く）。 */
export function richPlainText(value: LocalizedRichText): string {
  const visit = (nodes: readonly LocalizedRichTextNode[]): string => nodes.map((node) => node.type === "text" ? node.text : visit(node.children)).join("");
  return visit(value.children);
}

/* ---------- 概要 ---------- */

function parseSettings(input: unknown, path: string): LocalizationSettings {
  const source = record(input, path);
  keys(source, ["version", "autoDraft", "translator", "queue"], path);
  const translator = record(source.translator, `${path}.translator`);
  keys(translator, ["connected"], `${path}.translator`);
  const queue = record(source.queue, `${path}.queue`);
  keys(queue, ["waiting", "failed", "nextRetryAt"], `${path}.queue`);
  return {
    version: version(source.version, `${path}.version`), autoDraft: bool(source.autoDraft, `${path}.autoDraft`),
    translator: { connected: bool(translator.connected, `${path}.translator.connected`) },
    queue: { waiting: count(queue.waiting, `${path}.queue.waiting`), failed: count(queue.failed, `${path}.queue.failed`), nextRetryAt: timestamp(queue.nextRetryAt, `${path}.queue.nextRetryAt`) },
  };
}
function locale(value: unknown, path: string): LocalizationLocale {
  if (value !== "ja" && value !== "en") fail(path, "unsupported locale");
  return value;
}

export function parseLocalizationOverviewResult(input: unknown): LocalizationOverviewResult {
  const value = record(input, "overview");
  const denied = forbiddenOr(value, "overview", false);
  if (denied) return denied as LocalizationForbidden;
  keys(value, ["status", "overview"], "overview");
  if (value.status !== "ready") fail("overview.status", "invalid status");
  const path = "overview.overview", source = record(value.overview, path);
  keys(source, ["version", "sourceLocale", "targetLocale", "languages", "permissions", "groups", "release", "blockers", "catalog", "preview", "settings"], path);
  const sourceLocale = locale(source.sourceLocale, `${path}.sourceLocale`), targetLocale = locale(source.targetLocale, `${path}.targetLocale`);
  if (sourceLocale === targetLocale) fail(`${path}.targetLocale`, "target locale must differ from source locale");
  const languages = record(source.languages, `${path}.languages`);
  keys(languages, ["source", "target"], `${path}.languages`);
  const permissions = array(source.permissions, `${path}.permissions`, LOCALIZATION_PERMISSIONS.length).map((entry, index) => {
    if (!LOCALIZATION_PERMISSIONS.includes(entry as LocalizationPermission)) fail(`${path}.permissions[${index}]`, "unknown permission");
    return entry as LocalizationPermission;
  });
  if (new Set(permissions).size !== permissions.length) fail(`${path}.permissions`, "duplicate permission");
  const groups = array(source.groups, `${path}.groups`, LOCALIZATION_LIMITS.groups).map((entry, index) => {
    const at = `${path}.groups[${index}]`, group = record(entry, at);
    keys(group, ["id", "label", "items", "needsWork", "reviewed", "excluded"], at);
    const items = count(group.items, `${at}.items`);
    const result = { id: shortId(group.id, `${at}.id`), label: name(group.label, `${at}.label`), items, needsWork: count(group.needsWork, `${at}.needsWork`), reviewed: count(group.reviewed, `${at}.reviewed`), excluded: count(group.excluded, `${at}.excluded`) };
    if (result.needsWork + result.reviewed + result.excluded > items) fail(at, "group counts exceed items");
    return result;
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length) fail(`${path}.groups`, "duplicate group");
  const release = record(source.release, `${path}.release`);
  keys(release, ["current", "pending"], `${path}.release`);
  const catalogSource = record(source.catalog, `${path}.catalog`);
  let catalog: LocalizationCatalog;
  if (catalogSource.state === "current") { keys(catalogSource, ["state"], `${path}.catalog`); catalog = { state: "current" }; }
  else {
    keys(catalogSource, ["state", "progress"], `${path}.catalog`);
    if (catalogSource.state !== "updating") fail(`${path}.catalog.state`, "invalid catalog state");
    catalog = { state: "updating", progress: parseLocaleReleaseProgress(catalogSource.progress, `${path}.catalog.progress`) };
  }
  let preview: { frameUrl: string } | null = null;
  if (source.preview !== null) {
    const frame = record(source.preview, `${path}.preview`);
    keys(frame, ["frameUrl"], `${path}.preview`);
    if (!isPreviewFrameUrl(frame.frameUrl)) fail(`${path}.preview.frameUrl`, "invalid preview frame URL");
    preview = { frameUrl: frame.frameUrl };
  }
  return {
    status: "ready",
    overview: {
      version: version(source.version, `${path}.version`), sourceLocale, targetLocale,
      languages: { source: name(languages.source, `${path}.languages.source`, 40), target: name(languages.target, `${path}.languages.target`, 40) },
      permissions, groups,
      release: {
        current: release.current === null ? null : parseLocaleReleaseSummary(release.current, `${path}.release.current`),
        pending: release.pending === null ? null : parseLocaleReleasePending(release.pending, `${path}.release.pending`),
      },
      blockers: parseLocaleReleaseBlockers(source.blockers, `${path}.blockers`),
      catalog, preview, settings: parseSettings(source.settings, `${path}.settings`),
    },
  };
}

/* ---------- 一覧・1 件・項目 ---------- */

const ITEM_STATES: readonly LocalizationItemState[] = ["untranslated", "draft", "source-changed", "reviewed", "excluded"];
const SUMMARY_KEYS = ["key", "groupId", "title", "path", "includedParts", "state", "excludedReason", "totalUnits", "reviewedUnits", "imagesUnreviewed", "sourceDraftPending", "updatedAt", "updatedBy"];

function parseSummaryFields(source: Record<string, unknown>, path: string): LocalizationItemSummary {
  if (!ITEM_STATES.includes(source.state as LocalizationItemState)) fail(`${path}.state`, "invalid state");
  const state = source.state as LocalizationItemState;
  const excludedReason = nullableName(source.excludedReason, `${path}.excludedReason`, 400);
  if ((state === "excluded") !== (excludedReason !== null)) fail(`${path}.excludedReason`, "excluded items need a reason and others have none");
  const totalUnits = count(source.totalUnits, `${path}.totalUnits`, LOCALIZATION_LIMITS.units), reviewedUnits = count(source.reviewedUnits, `${path}.reviewedUnits`, LOCALIZATION_LIMITS.units);
  if (reviewedUnits > totalUnits) fail(`${path}.reviewedUnits`, "reviewed exceeds units");
  const includedParts = source.includedParts === undefined ? undefined : array(source.includedParts, `${path}.includedParts`, 8).map((part, index) => name(part, `${path}.includedParts[${index}]`, 80));
  if (includedParts && new Set(includedParts).size !== includedParts.length) fail(`${path}.includedParts`, "duplicate part");
  return {
    key: itemKey(source.key, `${path}.key`), groupId: shortId(source.groupId, `${path}.groupId`), title: lineText(source.title, `${path}.title`, 1000),
    path: sitePath(source.path, `${path}.path`), ...(includedParts === undefined ? {} : { includedParts }), state, excludedReason, totalUnits, reviewedUnits,
    imagesUnreviewed: count(source.imagesUnreviewed, `${path}.imagesUnreviewed`, LOCALIZATION_LIMITS.units),
    sourceDraftPending: bool(source.sourceDraftPending, `${path}.sourceDraftPending`),
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`), updatedBy: nullableName(source.updatedBy, `${path}.updatedBy`),
  };
}
export function parseLocalizationItemSummary(input: unknown, path = "summary"): LocalizationItemSummary {
  const source = record(input, path);
  keys(source, SUMMARY_KEYS, path);
  return parseSummaryFields(source, path);
}

export function parseLocalizationListResult(input: unknown): LocalizationListResult {
  const value = record(input, "list");
  const denied = forbiddenOr(value, "list", false);
  if (denied) return denied as LocalizationForbidden;
  keys(value, ["status", "items", "nextCursor"], "list");
  if (value.status !== "ready") fail("list.status", "invalid status");
  const items = array(value.items, "list.items", LOCALIZATION_LIMITS.listPage).map((entry, index) => parseLocalizationItemSummary(entry, `list.items[${index}]`));
  if (new Set(items.map((item) => item.key)).size !== items.length) fail("list.items", "duplicate item");
  return { status: "ready", items, nextCursor: cursor(value.nextCursor, "list.nextCursor") };
}

function textValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > LOCALIZATION_LIMITS.text || /[\u0000\u000b\u000c]/u.test(value)) fail(path, "invalid text");
  return value;
}
function richValue(value: unknown, path: string): LocalizedRichText {
  return parseLocalizationValue(value, "rich-text", path) as LocalizedRichText;
}
function imageValue(input: unknown, path: string): LocalizationImage {
  const source = record(input, path);
  keys(source, ["asset", "url"], path);
  if (!isDisplayableImageUrl(source.url) || source.url.startsWith("http:")) fail(`${path}.url`, "expected an https URL or a site path");
  return { asset: parseLocalizationValue(source.asset, "asset", `${path}.asset`) as LocalizedAsset, url: source.url };
}
function knownMarksOnly(value: string, known: ReadonlySet<string>, path: string): string {
  for (const id of markCounts(value).keys()) if (!known.has(id)) fail(path, "unknown mark");
  return value;
}
function richKnownOnly(value: LocalizedRichText, source: LocalizedRichText, path: string): LocalizedRichText {
  const known = new Map(richMarks(source).map((mark) => [mark.id, mark.tag]));
  for (const mark of richMarks(value)) if (known.get(mark.id) !== mark.tag) fail(path, "unknown rich text element");
  return value;
}
const UNIT_STATES: readonly LocalizationUnitState[] = ["source", "missing", "draft", "review-needed", "reviewed"];
const UNIT_BASE_KEYS = ["unitId", "label", "section", "required", "version", "sourceVersion", "state", "updatedAt", "updatedBy", "kind", "source", "value"];

export function parseLocalizationUnit(input: unknown, path = "unit"): LocalizationWorkspaceUnit {
  const source = record(input, path);
  const kind = source.kind;
  if (kind !== "text" && kind !== "rich-text" && kind !== "image") fail(`${path}.kind`, "invalid unit kind");
  keys(source, [...UNIT_BASE_KEYS, ...(kind === "text" ? ["previousSource", "candidate", "marks", "maxLength", "singleLine", "editOrigin"] : kind === "rich-text" ? ["previousSource", "candidate", "editOrigin"] : [])], path);
  if (!UNIT_STATES.includes(source.state as LocalizationUnitState)) fail(`${path}.state`, "invalid state");
  const state = source.state as LocalizationUnitState;
  const editOrigin = source.editOrigin;
  if (kind !== "image" && editOrigin !== undefined && editOrigin !== null && editOrigin !== "AUTO" && editOrigin !== "MANUAL") fail(`${path}.editOrigin`, "invalid edit origin");
  const required = bool(source.required, `${path}.required`);
  const base = {
    unitId: unitId(source.unitId, `${path}.unitId`), label: name(source.label, `${path}.label`), section: nullableName(source.section, `${path}.section`),
    required, version: version(source.version, `${path}.version`), sourceVersion: version(source.sourceVersion, `${path}.sourceVersion`), state,
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`), updatedBy: nullableName(source.updatedBy, `${path}.updatedBy`),
    ...(kind !== "image" && editOrigin !== undefined ? { editOrigin: editOrigin as LocalizationEditOrigin | null } : {}),
  };
  const hasValue = source.value !== null;
  if ((state === "source" || state === "missing") === hasValue) fail(`${path}.value`, "value does not fit the state");
  if (state === "source" && required) fail(`${path}.state`, "a required unit cannot use the source");
  if (kind === "image") return { ...base, kind, source: imageValue(source.source, `${path}.source`), value: hasValue ? imageValue(source.value, `${path}.value`) : null };
  if (source.previousSource !== null && state !== "review-needed") fail(`${path}.previousSource`, "previous source only belongs to review-needed");
  const candidateSource = source.candidate === null ? null : record(source.candidate, `${path}.candidate`);
  if (candidateSource) keys(candidateSource, ["candidateId", "value"], `${path}.candidate`);
  const candidateId = candidateSource ? pattern(candidateSource.candidateId, JOB_ID_RE, `${path}.candidate.candidateId`, "invalid candidate ID") : "";
  if (kind === "rich-text") {
    const sourceValue = richValue(source.source, `${path}.source`);
    const ids = richMarks(sourceValue).map((mark) => mark.id);
    if (new Set(ids).size !== ids.length) fail(`${path}.source`, "duplicate rich text element");
    return {
      ...base, kind, source: sourceValue,
      value: hasValue ? richKnownOnly(richValue(source.value, `${path}.value`), sourceValue, `${path}.value`) : null,
      previousSource: source.previousSource === null ? null : richValue(source.previousSource, `${path}.previousSource`),
      candidate: candidateSource ? { candidateId, value: richKnownOnly(richValue(candidateSource.value, `${path}.candidate.value`), sourceValue, `${path}.candidate.value`) } : null,
    };
  }
  const marks = array(source.marks, `${path}.marks`, LOCALIZATION_LIMITS.marks).map((entry, index) => {
    const at = `${path}.marks[${index}]`, mark = record(entry, at);
    keys(mark, ["id", "label"], at);
    return { id: pattern(mark.id, MARK_ID_RE, `${at}.id`, "invalid mark ID"), label: name(mark.label, `${at}.label`, 80) };
  });
  const known = new Set(marks.map((mark) => mark.id));
  if (known.size !== marks.length) fail(`${path}.marks`, "duplicate mark");
  const sourceText = textValue(source.source, `${path}.source`);
  const sourceCounts = markCounts(sourceText);
  if (sourceCounts.size !== marks.length || [...sourceCounts].some(([id, total]) => total !== 1 || !known.has(id))) fail(`${path}.source`, "source marks must match marks one to one");
  const maxLength = source.maxLength === null ? null : count(source.maxLength, `${path}.maxLength`, LOCALIZATION_LIMITS.text);
  if (maxLength === 0) fail(`${path}.maxLength`, "expected a positive limit");
  return {
    ...base, kind, source: sourceText,
    value: hasValue ? knownMarksOnly(textValue(source.value, `${path}.value`), known, `${path}.value`) : null,
    previousSource: source.previousSource === null ? null : textValue(source.previousSource, `${path}.previousSource`),
    candidate: candidateSource ? { candidateId, value: knownMarksOnly(textValue(candidateSource.value, `${path}.candidate.value`), known, `${path}.candidate.value`) } : null,
    marks, maxLength, singleLine: bool(source.singleLine, `${path}.singleLine`),
  };
}

function parseJob(input: unknown, path: string): LocalizationJob {
  const source = record(input, path);
  keys(source, ["jobId", "state", "message"], path);
  if (!["queued", "running", "done", "failed"].includes(source.state as string)) fail(`${path}.state`, "invalid job state");
  return { jobId: pattern(source.jobId, JOB_ID_RE, `${path}.jobId`, "invalid job ID"), state: source.state as LocalizationJob["state"], message: nullableName(source.message, `${path}.message`, 400) };
}

export function parseLocalizationItem(input: unknown, path = "item"): LocalizationItem {
  const source = record(input, path);
  keys(source, [...SUMMARY_KEYS, "units", "previews", "job"], path);
  const summary = parseSummaryFields(source, path);
  const units = array(source.units, `${path}.units`, LOCALIZATION_LIMITS.units).map((entry, index) => parseLocalizationUnit(entry, `${path}.units[${index}]`));
  if (new Set(units.map((unit) => unit.unitId)).size !== units.length) fail(`${path}.units`, "duplicate unit");
  const previews = array(source.previews, `${path}.previews`, LOCALIZATION_LIMITS.previews).map((entry, index) => {
    const at = `${path}.previews[${index}]`, choice = record(entry, at);
    keys(choice, ["id", "label"], at);
    return { id: shortId(choice.id, `${at}.id`), label: name(choice.label, `${at}.label`) };
  });
  if (new Set(previews.map((choice) => choice.id)).size !== previews.length) fail(`${path}.previews`, "duplicate preview");
  return { ...summary, units, previews, job: source.job === null ? null : parseJob(source.job, `${path}.job`) };
}

export function parseLocalizationItemResult(input: unknown, expectedKey: string): LocalizationItemResult {
  const value = record(input, "load");
  const shared = forbiddenOr(value, "load", true);
  if (shared) return shared;
  keys(value, ["status", "item"], "load");
  if (value.status !== "ready") fail("load.status", "invalid status");
  const item = parseLocalizationItem(value.item, "load.item");
  if (item.key !== expectedKey) fail("load.item.key", "item identity mismatch");
  return { status: "ready", item };
}

export function parseLocalizationCommandResult(input: unknown, expected: { readonly itemKey: string; readonly unitId: string }): LocalizationCommandResult {
  const value = record(input, "command");
  const shared = forbiddenOr(value, "command", true);
  if (shared) return shared;
  if (value.status === "invalid") return invalid(value, "command");
  keys(value, ["status", "unit", "summary"], "command");
  if (value.status !== "applied" && value.status !== "conflict") fail("command.status", "invalid status");
  const unit = parseLocalizationUnit(value.unit, "command.unit"), summary = parseLocalizationItemSummary(value.summary, "command.summary");
  if (unit.unitId !== expected.unitId) fail("command.unit.unitId", "unit identity mismatch");
  if (summary.key !== expected.itemKey) fail("command.summary.key", "item identity mismatch");
  return { status: value.status, unit, summary };
}

export function parseLocalizationTranslationResult(input: unknown): LocalizationTranslationResult {
  const value = record(input, "translate");
  const shared = forbiddenOr(value, "translate", true);
  if (shared) return shared;
  if (value.status === "invalid") return invalid(value, "translate");
  keys(value, ["status", "job"], "translate");
  if (value.status !== "queued") fail("translate.status", "invalid status");
  return { status: "queued", job: parseJob(value.job, "translate.job") };
}

export function parseLocalizationJobResult(input: unknown, expectedJobId: string): LocalizationJobResult {
  const value = record(input, "job");
  const shared = forbiddenOr(value, "job", true);
  if (shared) return shared;
  keys(value, ["status", "job"], "job");
  if (value.status !== "ready") fail("job.status", "invalid status");
  const job = parseJob(value.job, "job.job");
  if (job.jobId !== expectedJobId) fail("job.job.jobId", "job identity mismatch");
  return { status: "ready", job };
}

export function parseLocalizationCatalogResult(input: unknown): LocalizationCatalogResult {
  const value = record(input, "catalog");
  const denied = forbiddenOr(value, "catalog", false);
  if (denied) return denied as LocalizationForbidden;
  if (value.status === "current") { keys(value, ["status"], "catalog"); return { status: "current" }; }
  keys(value, ["status", "progress"], "catalog");
  if (value.status !== "updating") fail("catalog.status", "invalid status");
  return { status: "updating", progress: parseLocaleReleaseProgress(value.progress, "catalog.progress") };
}

/** プレビューの材料が素の JSON で、大きさの上限に収まるか。 */
function plainJson(value: unknown, path: string, depth = 0): void {
  if (depth > 64) fail(path, "material is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(path, "material has a non-finite number"); return; }
  if (Array.isArray(value)) { value.forEach((entry, index) => plainJson(entry, `${path}[${index}]`, depth + 1)); return; }
  const source = record(value, path);
  for (const [entryKey, entry] of Object.entries(source)) {
    if (RESERVED.has(entryKey)) fail(path, "material has a reserved key");
    plainJson(entry, path, depth + 1);
  }
}
/** JSON にしたときの大きさ（UTF-8 のバイト数）。 */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function parseLocalizationPreviewResult(input: unknown): LocalizationPreviewResult {
  const value = record(input, "preview");
  const shared = forbiddenOr(value, "preview", true);
  if (shared) return shared;
  keys(value, ["status", "material", "nextCursor"], "preview");
  if (value.status !== "ready") fail("preview.status", "invalid status");
  if (value.material === undefined) fail("preview.material", "material is required");
  plainJson(value.material, "preview.material");
  if (jsonBytes(value.material) > LOCALIZATION_LIMITS.previewBytes) fail("preview.material", "material is too large");
  return { status: "ready", material: value.material, nextCursor: cursor(value.nextCursor, "preview.nextCursor") };
}

export function parseLocalizationSettingsResult(input: unknown): LocalizationSettingsResult {
  const value = record(input, "settings");
  const denied = forbiddenOr(value, "settings", false);
  if (denied) return denied as LocalizationForbidden;
  if (value.status === "invalid") return invalid(value, "settings");
  keys(value, ["status", "settings"], "settings");
  if (value.status !== "saved" && value.status !== "conflict") fail("settings.status", "invalid status");
  return { status: value.status, settings: parseSettings(value.settings, "settings.settings") };
}

export function parseLocalizationImageResult(input: unknown): LocalizationImageResult {
  const value = record(input, "image");
  if (value.status === "cancelled") { keys(value, ["status"], "image"); return { status: "cancelled" }; }
  if (value.status === "rejected") {
    keys(value, ["status", "reason"], "image");
    if (!["type", "size", "permission", "invalid"].includes(value.reason as string)) fail("image.reason", "invalid reason");
    return { status: "rejected", reason: value.reason as LocalizationImageRejectReason };
  }
  keys(value, ["status", "image"], "image");
  if (value.status !== "uploaded" && value.status !== "picked") fail("image.status", "invalid status");
  return { status: value.status, image: imageValue(value.image, "image.image") };
}

/* ---------- 画面の補助 ---------- */

export type LocalizationFilter = "all" | "needs-work" | "reviewed" | "excluded";
export function localizationItemFilter(state: LocalizationItemState): Exclude<LocalizationFilter, "all"> {
  return state === "reviewed" ? "reviewed" : state === "excluded" ? "excluded" : "needs-work";
}
/** 操作ごとの operationId（base64url の 22 文字）。 */
export function createOperationId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** 訳文の入力を確かめる。保存してよければ null、だめなら人が読む文。labels は印の id → 名前。 */
export function localizedInputProblem(unit: LocalizationTextUnit | LocalizationRichTextUnit, segments: readonly MarkSegment[]): { readonly message: string } | { readonly value: string | LocalizedRichText } {
  const labelOf = (ids: readonly string[]) => {
    const names = unit.kind === "text" ? new Map(unit.marks.map((mark) => [mark.id, mark.label])) : new Map(richMarks(unit.source).map((mark) => [mark.id, mark.label]));
    return [...new Set(ids.map((id) => names.get(id) ?? "印"))].join("・");
  };
  const markMessage = (problem: MarkProblem) => problem.kind === "missing" ? `札が足りません：${labelOf(problem.ids)}。切り取った札は、貼り付けると戻ります。`
    : problem.kind === "extra" ? `札が多すぎます：${labelOf(problem.ids)}。同じ札は 1 つだけにしてください。`
    : problem.kind === "unknown" ? "原文に無い札があります。貼り付けた文字を確かめてください。"
    : `札の並びが原文と合いません：${labelOf(problem.ids)}。始まりの札を終わりの札より前に置いてください。`;
  if (unit.kind === "text") {
    const text = segmentsToText(segments);
    const problem = checkTextMarks(text, unit.marks);
    if (problem) return { message: markMessage(problem) };
    if (unit.singleLine && /[\r\n]/u.test(text)) return { message: "改行は入れられません。" };
    const length = visibleLength(text);
    if (unit.maxLength !== null && length > unit.maxLength) return { message: `${unit.maxLength} 文字以内にしてください（いま ${length} 文字）。` };
    if (text.length > LOCALIZATION_LIMITS.text) return { message: "長すぎます。短くしてください。" };
    if (unit.required && !text.replace(MARK_TOKEN, "").trim()) return { message: "訳文を入れてください。" };
    return { value: text };
  }
  const result = segmentsToRichText(segments, unit.source);
  if ("problem" in result) return { message: markMessage(result.problem) };
  const plain = richPlainText(result.value);
  if (plain.length > LOCALIZATION_LIMITS.text) return { message: "長すぎます。短くしてください。" };
  if (unit.required && !plain.trim()) return { message: "訳文を入れてください。" };
  try { parseLocalizationValue(result.value, "rich-text", "value"); } catch { return { message: "この形では保存できません。札の位置を確かめてください。" }; }
  return { value: result.value };
}

/* ---------- プレビューの枠との受け渡し ---------- */

export const PREVIEW_MESSAGE_TYPE = "niho-localization-preview";
export const PREVIEW_PROTOCOL = 1;
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/u;
/** 枠を開くたびに作る 32 文字の nonce。 */
export function createPreviewNonce(): string {
  return (createOperationId() + createOperationId()).slice(0, 32);
}
/** 枠の URL に nonce を付ける（#niho-preview=<nonce>）。 */
export function previewFrameSrc(frameUrl: string, nonce: string): string {
  if (!isPreviewFrameUrl(frameUrl) || !NONCE_RE.test(nonce)) throw new DocumentValidationError("preview", "invalid frame URL or nonce");
  return `${frameUrl}#niho-preview=${nonce}`;
}
export type PreviewFrameEvent = { readonly event: "ready" | "rendered" } | { readonly event: "error"; readonly message: string | null };
/** 枠からの message。type・protocol・nonce が合わないものは null（捨てる）。送り元（event.source）は呼ぶ側で確かめる。 */
export function parsePreviewFrameMessage(data: unknown, nonce: string): PreviewFrameEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const source = data as Record<string, unknown>;
  if (source.type !== PREVIEW_MESSAGE_TYPE || source.protocol !== PREVIEW_PROTOCOL || source.nonce !== nonce) return null;
  if (Object.keys(source).some((entry) => !["type", "protocol", "nonce", "event", "message"].includes(entry))) return null;
  if (source.event === "ready" || source.event === "rendered") return { event: source.event };
  if (source.event === "error") {
    const message = typeof source.message === "string" && source.message.length <= 400 && !/[\u0000-\u001f\u007f]/u.test(source.message) ? source.message : null;
    return { event: "error", message };
  }
  return null;
}
export type PreviewOverride = { readonly unitId: string; readonly value: string | LocalizedRichText | LocalizationImage | null };
export type PreviewRenderMessage = {
  readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly protocol: typeof PREVIEW_PROTOCOL; readonly nonce: string; readonly event: "render";
  readonly locale: LocalizationLocale; readonly width: number | null; readonly materials: readonly unknown[]; readonly overrides: readonly PreviewOverride[];
};

export { DocumentValidationError as LocalizationWorkspaceValidationError };
