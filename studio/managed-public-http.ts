export async function withPublicEtag(body: string, headers: HeadersInit): Promise<Response> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const etag = `\"${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}\"`;
  const responseHeaders = new Headers(headers);
  responseHeaders.set("ETag", etag);
  return new Response(body, { headers: responseHeaders });
}

export function revalidatePublicResponse(request: Request, response: Response): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  const etag = response.headers.get("ETag"), value = request.headers.get("If-None-Match");
  if (!etag || !value || !value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized.replace(/^W\//u, "") === etag;
  })) return response;
  return new Response(null, { status: 304, headers: response.headers });
}
