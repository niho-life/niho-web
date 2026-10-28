import type { EmbedDescriptor, EmbedProvider } from "./types.js";
import { fail, keys, line, record } from "./validation-utils.js";

const youtubeId = /^[A-Za-z0-9_-]{11}$/u;
const vimeoId = /^[0-9]{1,20}$/u;
const vimeoHash = /^[A-Za-z0-9_-]{1,128}$/u;
const lottieUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const lottieFilename = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9_-])?\.(?:json|lottie)$/u;
const facebookActor = /^[A-Za-z0-9](?:[A-Za-z0-9.]{0,78}[A-Za-z0-9])?$/u;
const facebookActorId = /^[0-9]{1,32}$/u;
const facebookPostId = /^(?:[0-9]{1,32}|pfbid[A-Za-z0-9]{20,195})$/u;
const xHandle = /^[A-Za-z0-9_]{1,15}$/u;
const xPostId = /^[0-9]{1,20}$/u;
const instagramShortcode = /^[A-Za-z0-9_-]{1,64}$/u;
const blankEmbedKey = /^[a-z][a-z0-9-]{0,31}$/u;
const providers = new Set<EmbedProvider>(["map", "youtube", "vimeo", "lottie", "facebook", "x", "instagram", "blank"]);

export type BlankEmbedSandboxMode = "strict" | "scripts" | "forms" | "scripts-forms" | "same-origin" | "same-origin-forms" | "same-origin-scripts" | "same-origin-scripts-forms";
export type BlankEmbedRegistryEntry = Readonly<{ key: string; label: string; src: string; sandbox: BlankEmbedSandboxMode }>;
export type BlankEmbedRegistry = Readonly<{ parentOrigin: string; entries: readonly BlankEmbedRegistryEntry[] }>;
const blankSandbox: Readonly<Record<BlankEmbedSandboxMode, string>> = {
  strict: "", scripts: "allow-scripts", forms: "allow-forms", "scripts-forms": "allow-scripts allow-forms",
  "same-origin": "allow-same-origin", "same-origin-forms": "allow-same-origin allow-forms",
  "same-origin-scripts": "allow-same-origin allow-scripts", "same-origin-scripts-forms": "allow-same-origin allow-scripts allow-forms"
};

function blankUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 2048 || /[\s\u0000-\u001f\u007f\\<>"'`?#]/u.test(value)) throw new Error(`Invalid blank embed ${label}`);
  const authority = /^https:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes(":")) throw new Error(`Invalid blank embed ${label}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid blank embed ${label}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !url.hostname || url.pathname.includes("//")) throw new Error(`Invalid blank embed ${label}`);
  return url;
}

/** trusted host code の静的 registry を厳格に検証し、renderer が再検証できる正規形へコピーする。 */
export function parseBlankEmbedRegistry(value: unknown): BlankEmbedRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid blank embed registry");
  const source = value as Record<string, unknown>;
  if (Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null || Object.keys(source).some((key) => !["parentOrigin", "entries"].includes(key))) throw new Error("Invalid blank embed registry");
  const parent = blankUrl(source.parentOrigin, "parent origin");
  if (parent.pathname !== "/") throw new Error("Blank embed parentOrigin must be an HTTPS origin");
  if (!Array.isArray(source.entries) || source.entries.length > 16) throw new Error("Blank embed registry accepts at most 16 entries");
  const found = new Set<string>(), entries: BlankEmbedRegistryEntry[] = source.entries.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid blank embed registry entry");
    const entry = input as Record<string, unknown>;
    if (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null || Object.keys(entry).some((key) => !["key", "label", "src", "sandbox"].includes(key))) throw new Error("Invalid blank embed registry entry");
    if (typeof entry.key !== "string" || !blankEmbedKey.test(entry.key) || found.has(entry.key)) throw new Error("Blank embed keys must be unique short identifiers");
    if (typeof entry.label !== "string" || !entry.label.trim() || entry.label !== entry.label.trim() || entry.label.length > 100 || /[\u0000-\u001f\u007f]/u.test(entry.label)) throw new Error("Invalid blank embed label");
    if (typeof entry.sandbox !== "string" || !Object.prototype.hasOwnProperty.call(blankSandbox, entry.sandbox)) throw new Error("Invalid blank embed sandbox mode");
    const src = blankUrl(entry.src, "source"), sandbox = entry.sandbox as BlankEmbedSandboxMode;
    if (src.origin === parent.origin && blankSandbox[sandbox].includes("allow-scripts") && blankSandbox[sandbox].includes("allow-same-origin")) throw new Error("Same-origin blank embeds cannot combine scripts with origin retention");
    found.add(entry.key);
    return Object.freeze({ key: entry.key, label: entry.label, src: src.href, sandbox });
  });
  return Object.freeze({ parentOrigin: parent.origin, entries: Object.freeze(entries) });
}

/** 型付きの trusted host 設定口。JavaScript 入力も parseBlankEmbedRegistry と同じ規則で検証する。 */
export function createBlankEmbedRegistry(value: { parentOrigin: string; entries: readonly BlankEmbedRegistryEntry[] }): BlankEmbedRegistry {
  return parseBlankEmbedRegistry(value);
}

/** renderer 用の fail-closed 解決。未知 key は URL を返さない。 */
export function resolveBlankEmbed(registry: BlankEmbedRegistry | undefined, key: string): (BlankEmbedRegistryEntry & { sandboxValue: string }) | undefined {
  if (!registry || !blankEmbedKey.test(key)) return undefined;
  const parsed = parseBlankEmbedRegistry(registry), entry = parsed.entries.find((candidate) => candidate.key === key);
  return entry ? { ...entry, sandboxValue: blankSandbox[entry.sandbox] } : undefined;
}

function invalid(provider: EmbedProvider): never {
  throw new Error(provider === "map" ? "Google Maps の共有画面で取得した埋め込み URL を入力してください。"
    : provider === "youtube" ? "YouTube の動画 URL を入力してください。"
    : provider === "vimeo" ? "Vimeo の動画 URL を入力してください。"
    : provider === "lottie" ? "LottieFiles の lottie.host Asset link を入力してください。"
    : provider === "facebook" ? "Facebook の公開投稿 URL を入力してください。"
    : provider === "x" ? "X の公開ポスト URL を入力してください。"
    : provider === "instagram" ? "Instagram の公開投稿またはリール URL を入力してください。"
    : "ホストが承認した Blank 埋め込みを選択してください。");
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
  if (provider === "blank") {
    if (!blankEmbedKey.test(value)) invalid(provider);
    return value;
  }
  const url = safeUrl(value, provider), host = url.hostname.toLowerCase();
  if (provider === "x") {
    if (host !== "x.com") invalid(provider);
    const post = /^https:\/\/x\.com\/([^/?#]+)\/status\/([^/?#]+)\/?$/u.exec(value);
    if (!post || !xHandle.test(post[1]!) || !xPostId.test(post[2]!)) invalid(provider);
    return `https://x.com/${post[1]!.toLowerCase()}/status/${post[2]!}`;
  }
  if (provider === "instagram") {
    if (host !== "instagram.com" && host !== "www.instagram.com") invalid(provider);
    const post = /^https:\/\/(?:www\.)?instagram\.com\/(p|reel)\/([^/?#]+)\/?$/u.exec(value);
    if (!post || !instagramShortcode.test(post[2]!)) invalid(provider);
    return `https://www.instagram.com/${post[1]!.toLowerCase()}/${post[2]!}/`;
  }
  if (provider === "facebook") {
    if (host !== "facebook.com" && host !== "www.facebook.com") invalid(provider);
    const post = /^https:\/\/(?:www\.)?facebook\.com\/([^/?#]+)\/posts\/(?:[A-Za-z0-9_-]{1,200}\/)?([^/?#]+)\/?$/u.exec(value);
    const actor = post?.[1];
    if (post && actor && facebookActor.test(actor) && !actor.includes("..") && (!/^\d+$/u.test(actor) || facebookActorId.test(actor)) && facebookPostId.test(post[2]!)) {
      return `https://www.facebook.com/${post[1]!}/posts/${post[2]!}`;
    }
    const permalink = /^https:\/\/(?:www\.)?facebook\.com\/permalink\.php\?story_fbid=([^&]+)&id=([^&]+)$/u.exec(value);
    if (permalink && facebookPostId.test(permalink[1]!) && facebookActorId.test(permalink[2]!)) {
      return `https://www.facebook.com/permalink.php?story_fbid=${permalink[1]!}&id=${permalink[2]!}`;
    }
    invalid(provider);
  }
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
