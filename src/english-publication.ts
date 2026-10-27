export const ENGLISH_PUBLICATION_STATES = [
  "initial-release-required",
  "queued",
  "translating",
  "review-required",
  "publishing",
  "published",
  "withdrawn",
  "retryable-failure",
  "superseded"
] as const;

export type EnglishPublicationState = typeof ENGLISH_PUBLICATION_STATES[number];
export type EnglishPublication = {
  readonly state: EnglishPublicationState;
  readonly retryable: boolean;
  readonly updatedAt?: string;
};
export type EnglishPublications = Readonly<Record<string, EnglishPublication>>;
export type EnglishPublicationsResult<S extends "ready" | "accepted" = "ready" | "accepted"> = {
  readonly status: S;
  readonly englishPublications: EnglishPublications;
};
export type EnglishPublicationRetryResult =
  | { readonly status: "accepted"; readonly englishPublication: EnglishPublication }
  | { readonly status: "conflict" };

const states: ReadonlySet<string> = new Set(ENGLISH_PUBLICATION_STATES);
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("英語公開状態が正しくありません。");
  return value as Record<string, unknown>;
}

function exactKeys(source: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(source, key)) || Object.keys(source).some((key) => !allowed.has(key))) {
    throw new Error("英語公開状態が正しくありません。");
  }
}

/** Browser adapter と BFF が共有する fail-closed parser。既知 field だけを新しい DTO に再構成する。 */
export function parseEnglishPublication(value: unknown): EnglishPublication {
  const source = record(value);
  exactKeys(source, ["state", "retryable"], ["updatedAt"]);
  if (typeof source.state !== "string" || !states.has(source.state) || typeof source.retryable !== "boolean") throw new Error("英語公開状態が正しくありません。");
  let updatedAt: string | undefined;
  if (source.updatedAt !== undefined) {
    if (typeof source.updatedAt !== "string" || source.updatedAt.length > 40 || !isoTimestamp.test(source.updatedAt)) throw new Error("英語公開状態が正しくありません。");
    const timestamp = Date.parse(source.updatedAt);
    if (!Number.isFinite(timestamp)) throw new Error("英語公開状態が正しくありません。");
    updatedAt = new Date(timestamp).toISOString();
  }
  return { state: source.state as EnglishPublicationState, retryable: source.retryable, ...(updatedAt === undefined ? {} : { updatedAt }) };
}

export function parseEnglishPublicationAccepted(value: unknown): Extract<EnglishPublicationRetryResult, { status: "accepted" }> {
  const source = record(value);
  exactKeys(source, ["status", "englishPublication"]);
  if (source.status !== "accepted") throw new Error("英語公開状態が正しくありません。");
  return { status: "accepted", englishPublication: parseEnglishPublication(source.englishPublication) };
}

/**
 * CMS のページ別状態 map を、呼び出し側が指定した page ID の完全一致で読む。
 * 未知の page ID、欠けた page ID、各状態の余分な field はすべて拒否する。
 */
export function parseEnglishPublications(value: unknown, expectedPageIds: readonly string[]): EnglishPublications {
  const source = record(value);
  if (new Set(expectedPageIds).size !== expectedPageIds.length || expectedPageIds.some((pageId) => !pageId || pageId.length > 256 || /[\u0000-\u001f\u007f]/u.test(pageId))) {
    throw new Error("英語公開状態が正しくありません。");
  }
  exactKeys(source, expectedPageIds);
  if (expectedPageIds.some((pageId) => !Object.hasOwn(source, pageId))) throw new Error("英語公開状態が正しくありません。");
  return Object.fromEntries(expectedPageIds.map((pageId) => [pageId, parseEnglishPublication(source[pageId])])) as EnglishPublications;
}

/** CMS の GET / POST 成功応答を既知 field だけに再構成する。 */
export function parseEnglishPublicationsResult<S extends "ready" | "accepted">(value: unknown, expectedStatus: S, expectedPageIds: readonly string[]): EnglishPublicationsResult<S> {
  const source = record(value);
  exactKeys(source, ["status", "englishPublications"]);
  if (source.status !== expectedStatus) throw new Error("英語公開状態が正しくありません。");
  return { status: expectedStatus, englishPublications: parseEnglishPublications(source.englishPublications, expectedPageIds) };
}
