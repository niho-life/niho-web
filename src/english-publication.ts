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
