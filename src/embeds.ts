import type { EmbedDescriptor, EmbedProvider } from "./types.js";
import { fail, keys, line, record } from "./validation-utils.js";

const youtubeId = /^[A-Za-z0-9_-]{11}$/u;
const vimeoId = /^[0-9]{1,20}$/u;
const vimeoHash = /^[A-Za-z0-9_-]{1,128}$/u;
const lottieUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const lottieFilename = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9_-])?\.(?:json|lottie)$/u;
const providers = new Set<EmbedProvider>(["map", "youtube", "vimeo", "lottie"]);

function invalid(provider: EmbedProvider): never {
  throw new Error(provider === "map" ? "Google Maps の共有画面で取得した埋め込み URL を入力してください。"
    : provider === "youtube" ? "YouTube の動画 URL を入力してください。"
    : provider === "vimeo" ? "Vimeo の動画 URL を入力してください。"
    : "LottieFiles の lottie.host Asset link を入力してください。");
}

function safeUrl(value: string, provider: EmbedProvider): URL {
  if (!value || value.length > 16384 || value !== value.trim() || /[\s\u0000-\u001f\u007f\\<>"'`]/u.test(value)) invalid(provider);
  const authority = /^https:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes(":")) invalid(provider);
  let url: URL;
  try { url = new URL(value); } catch { return invalid(provider); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) invalid(provider);
  return url;
}

function onlyQuery(url: URL, names: readonly string[]): boolean {
  const entries: [string, string][] = [];
  url.searchParams.forEach((value, name) => entries.push([name, value]));
  return entries.length === names.length && entries.every(([name], index) => name === names[index]);
}

function youtubeQuery(url: URL, watch: boolean): boolean {
  const entries: [string, string][] = [];
  url.searchParams.forEach((value, name) => entries.push([name, value]));
  const allowed = watch ? new Set(["v", "si"]) : new Set(["si"]);
  if (entries.some(([name]) => !allowed.has(name)) || new Set(entries.map(([name]) => name)).size !== entries.length) return false;
  if (watch && !url.searchParams.has("v")) return false;
  const share = url.searchParams.get("si");
  return share === null || /^[A-Za-z0-9_-]{1,128}$/u.test(share);
}

/** 編集入力を provider 固有の canonical iframe URL に変換する。空文字は呼び出し側で未設定として扱う。 */
export function normalizeEmbedSource(provider: EmbedProvider, value: string): string {
  if (!providers.has(provider)) throw new Error("未対応の埋め込みサービスです。");
  const url = safeUrl(value, provider), host = url.hostname.toLowerCase();
  if (provider === "lottie") {
    if (host !== "lottie.host" || /[?#]/u.test(value)) invalid(provider);
    const match = /^\/(?:embed\/)?([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (!match || !lottieUuid.test(match[1]!) || !lottieFilename.test(match[2]!)) invalid(provider);
    return `https://lottie.host/embed/${match[1]!.toLowerCase()}/${match[2]!}`;
  }
  if (provider === "youtube") {
    let id: string | undefined;
    if ((host === "youtube.com" || host === "www.youtube.com") && url.pathname === "/watch" && youtubeQuery(url, true)) id = url.searchParams.get("v") ?? undefined;
    else if ((host === "youtube.com" || host === "www.youtube.com") && youtubeQuery(url, false)) id = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)?.[1];
    else if (host === "youtu.be" && youtubeQuery(url, false)) id = /^\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)?.[1];
    if (!id || !youtubeId.test(id)) invalid(provider);
    return `https://www.youtube-nocookie.com/embed/${id}`;
  }
  if (provider === "vimeo") {
    const id = host === "vimeo.com" ? /^\/([0-9]{1,20})$/u.exec(url.pathname)?.[1]
      : host === "player.vimeo.com" ? /^\/video\/([0-9]{1,20})$/u.exec(url.pathname)?.[1] : undefined;
    if (!id || !vimeoId.test(id)) invalid(provider);
    let hash: string | undefined;
    if (url.search) {
      if (!onlyQuery(url, ["h"])) invalid(provider);
      hash = url.searchParams.get("h") ?? undefined;
      if (!hash || !vimeoHash.test(hash)) invalid(provider);
    }
    return `https://player.vimeo.com/video/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ""}`;
  }
  if (host !== "www.google.com" || url.pathname !== "/maps/embed" || !url.search.startsWith("?pb=") || url.search.includes("&")) invalid(provider);
  const raw = url.search.slice(4);
  let pb: string;
  try { pb = decodeURIComponent(raw); } catch { return invalid(provider); }
  if (pb.length < 10 || pb.length > 16000 || /[\u0000-\u001f\u007f<>]/u.test(pb)) invalid(provider);
  return `https://www.google.com/maps/embed?pb=${encodeURIComponent(pb).replaceAll("'", "%27")}`;
}

export function parseEmbedDescriptor(value: unknown, path: string): EmbedDescriptor {
  const source = record(value, path);
  keys(source, ["provider", "title", "source"], path);
  if (typeof source.provider !== "string" || !providers.has(source.provider as EmbedProvider)) fail(`${path}.provider`, "unsupported embed provider");
  const provider = source.provider as EmbedProvider, title = line(source.title, `${path}.title`, 300);
  if (source.source === undefined) return { provider, title };
  const input = line(source.source, `${path}.source`, 16384);
  try {
    const normalized = provider === "youtube" && /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/u.test(input)
      ? input : normalizeEmbedSource(provider, input);
    return { provider, title, source: normalized };
  }
  catch { return fail(`${path}.source`, "invalid embed source"); }
}
