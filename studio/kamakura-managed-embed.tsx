import { useEffect, useState } from "react";
import type { EditorBlockSettingsProps } from "../src/editor-types.js";

const BASE = "/api/projects/project-kamakura/sites/kamakura/editor/embeds";
const REF_ID = /^emb_[0-9a-f]{32}$/u;
type Flow = "dropin" | "rental";
type Connection = { status: "unconfigured" | "draft" | "published"; refId?: string; flow?: Flow; version?: string; verification?: "format_only"; message?: string };

function entity(value: string): string {
  return value.replace(/&amp;|&#0*38;|&#x0*26;/giu, "&").replace(/&quot;|&#0*34;|&#x0*22;/giu, '"').replace(/&apos;|&#0*39;|&#x0*27;/giu, "'");
}

export function extractKamakuraManagedEmbedUrl(input: string): string {
  const source = entity(input.trim());
  if (/^https:\/\//iu.test(source)) return source;
  const iframe = /<iframe\b[^>]*>/iu.exec(source)?.[0];
  const match = iframe && /\b(?:data-niho-embed-src|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(iframe);
  const url = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!url) throw new Error("iframe URL または iframe を含むコードを貼り付けてください。");
  return entity(url);
}

function tokenPayload(token: string): Record<string, unknown> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) throw new Error("launchToken の形式を確認してください。");
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("launchToken の payload を読み取れませんでした。"); }
}

function pathAllowed(prefix: unknown, path: string): boolean {
  if (prefix === null) return true;
  if (typeof prefix !== "string" || !prefix.startsWith("/") || /[?#\\]/u.test(prefix)) return false;
  const normalized = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (normalized === "/") return path.startsWith("/");
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function inspectKamakuraManagedEmbed(input: string, path: string): { flow: Flow } {
  let url: URL;
  try { url = new URL(extractKamakuraManagedEmbedUrl(input)); } catch (error) { if (error instanceof Error) throw error; throw new Error("iframe URL を確認してください。"); }
  if (url.origin !== "https://niho.life" || url.username || url.password || url.port || url.hash) throw new Error("next-kamakura.niho.life 用ではない NIHO 環境またはドメインです。");
  const route = /^\/embed\/(dropin|rental)\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
  if (!route) throw new Error("ドロップインまたは貸切の iframe URL を貼り付けてください。");
  const allowed = new Set(["launchToken", "embed", "bg", "accent"]);
  let unknownQuery = "";
  url.searchParams.forEach((_value, key) => { if (!allowed.has(key) && !unknownQuery) unknownQuery = key; });
  if (unknownQuery) throw new Error(`許可されていない query（${unknownQuery}）があります。`);
  const launchTokens = url.searchParams.getAll("launchToken");
  if (launchTokens.length !== 1 || !launchTokens[0]) throw new Error("launchToken が1つ必要です。");
  const payload = tokenPayload(launchTokens[0]);
  if (payload.v !== 1 || payload.flow !== route[1] || payload.spotId !== route[2]) throw new Error("URL と launchToken の flow／対象が一致しません。");
  if (payload.parentOrigin !== "https://next-kamakura.niho.life") throw new Error("launchToken の公開先ドメインが next-kamakura.niho.life と一致しません。");
  if (!pathAllowed(payload.allowedPathPrefix, path)) throw new Error("launchToken の許可 path がこのページと一致しません。");
  return { flow: route[1] as Flow };
}

async function request(pageId: string, operation: "import" | "status", body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${BASE}/${pageId}/${operation}`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") ? await response.json() as unknown : null;
  if (!response.ok) throw new Error(response.status === 409 ? "ほかの変更が入りました。状態を読み直して、もう一度貼り付けてください。" : "埋め込み設定を保存できませんでした。入力内容と接続状態を確認してください。");
  return value;
}

function connection(value: unknown): Connection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("埋め込み設定の応答が正しくありません。");
  const source = value as Record<string, unknown>;
  if (!["unconfigured", "draft", "published"].includes(String(source.status))) throw new Error("埋め込み設定の応答が正しくありません。");
  if (source.status !== "unconfigured" && (typeof source.refId !== "string" || !REF_ID.test(source.refId) || !["dropin", "rental"].includes(String(source.flow)) || typeof source.version !== "string" || source.verification !== "format_only")) throw new Error("埋め込み設定の応答が正しくありません。");
  return source as Connection;
}

export function KamakuraManagedEmbedSettings({ node, target, pagePath, disabled, setProp, notify }: EditorBlockSettingsProps) {
  const refId = typeof node.props.refId === "string" && REF_ID.test(node.props.refId) ? node.props.refId : null;
  const [source, setSource] = useState("");
  const [state, setState] = useState<Connection>({ status: refId ? "draft" : "unconfigured" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!refId) { setState({ status: "unconfigured" }); return; }
    const controller = new AbortController();
    setError("");
    void request(target.pageId, "status", { refId }).then((value) => { if (!controller.signal.aborted) setState(connection(value)); }).catch(() => { if (!controller.signal.aborted) setError("接続状態を読み込めませんでした。"); });
    return () => controller.abort();
  }, [refId, target.pageId]);
  const save = async () => {
    setError("");
    try {
      if (!pagePath || pagePath.includes("[")) throw new Error("このページでは埋め込みを設定できません。");
      const path = pagePath;
      inspectKamakuraManagedEmbed(source, path);
      setBusy(true);
      const next = connection(await request(target.pageId, "import", { source, ...(refId ? { refId, expectedVersion: state.version } : {}) }));
      setState(next);
      setProp("refId", next.refId);
      setSource("");
      notify("埋め込み設定を非公開領域へ保存しました。ページの下書きを保存してください。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "埋め込み設定を保存できませんでした。"); }
    finally { setBusy(false); }
  };
  const background = node.props.background === "transparent" ? "transparent" : "white";
  const initialHeight = typeof node.props.initialHeight === "number" ? node.props.initialHeight : 720;
  return <div className="e-block-settings" data-managed-embed-settings="">
    <p className="e-help">NIHO でコピーした iframe URL または iframe と script のコードを貼り付けます。script・style・イベント属性は保存も実行もしません。</p>
    <label className="e-field"><span>埋め込みコード</span><textarea rows={6} maxLength={12_000} value={source} disabled={disabled || busy} spellCheck={false} onChange={(event) => setSource(event.target.value)} placeholder="https://niho.life/embed/… または <iframe …></iframe>" /></label>
    <button type="button" className="e-primary" disabled={disabled || busy || !source.trim()} onClick={() => void save()}>{busy ? "確認しています…" : refId ? "接続設定を更新" : "コードを確認して接続"}</button>
    {error && <p className="e-error" role="alert">{error}</p>}
    <p className="e-help" role="status">状態: {state.status === "published" ? "公開済み" : state.status === "draft" ? "有効（次回公開で反映）" : "未設定"}{state.flow ? `・${state.flow === "rental" ? "貸切" : "ドロップイン"}` : ""}</p>
    {state.status !== "unconfigured" && <p className="e-help">形式確認済み、実接続は公開先で確認してください。NIHO API による署名確認済みとは扱いません。</p>}
    <label className="e-field"><span>背景</span><select value={background} disabled={disabled} onChange={(event) => setProp("background", event.target.value)}><option value="white">白</option><option value="transparent">透明</option></select></label>
    <label className="e-field"><span>読込前の高さ（px）</span><input type="number" min={240} max={1600} value={initialHeight} disabled={disabled} onChange={(event) => setProp("initialHeight", Math.min(1600, Math.max(240, Number(event.target.value) || 720)))} /></label>
  </div>;
}
