export class SessionExpiredError extends Error {}
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid API response");
  return value as Record<string, unknown>;
}

export async function api(path: string, options: { readonly method?: "GET" | "POST"; readonly body?: Record<string, unknown>; readonly signal?: AbortSignal } = {}): Promise<unknown> {
  const method = options.method ?? "GET";
  const response = await fetch(path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: method === "POST" ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
  if (response.status === 401) throw new SessionExpiredError("Access session expired");
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("Studio API request failed");
  const value = await response.json() as unknown;
  if (!response.ok) {
    const error = record(value).error;
    throw new ApiError(response.status, typeof error === "string" ? error : "request_failed");
  }
  return value;
}

export function text(value: unknown, maximum = 254): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("invalid API response");
  return value;
}

export function role(value: unknown): "owner" | "editor" {
  if (value !== "owner" && value !== "editor") throw new Error("invalid API response");
  return value;
}

export function timestamp(value: unknown): string {
  const parsed = text(value, 40);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error("invalid API response");
  return parsed;
}
