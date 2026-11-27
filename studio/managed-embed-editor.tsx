import { useEffect, useRef, useState } from "react";
import type { EditorBlockRegistry, EditorBlockSettingsProps } from "../src/editor-types.js";
import { api, ApiError, record } from "./api-client.js";
import { MANAGED_EMBED_REF, managedEmbedContract } from "./managed-embed-contract.js";

function EmbedConnection({ node, target, disabled, setProp, notify, base }: EditorBlockSettingsProps & { base: string }) {
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function connect() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = record(await api(`${base}/${encodeURIComponent(target.pageId)}/embed-connection`, {
        method: "POST", body: { src: src.trim(), locale: target.locale }, signal: controller.signal
      }));
      if (controller.signal.aborted) return;
      if (typeof response.refId !== "string" || !MANAGED_EMBED_REF.test(response.refId)) throw new Error();
      setProp("refId", response.refId);
      setSrc("");
      notify("接続設定を保存しました。ページを公開すると反映されます。");
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof ApiError && error.code === "embed_origin_not_allowed"
        ? "埋め込み先をプロジェクトの公開配信設定で許可してください。"
        : error instanceof ApiError && error.code === "invalid_embed_url"
          ? "NIHO で発行した埋め込み URL と、設定した公開先を確認してください。"
          : "接続設定を保存できませんでした。");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="e-block-settings">
    <label className="e-field"><span>NIHO の埋め込み URL</span>
      <input value={src} maxLength={8192} autoComplete="off" spellCheck={false} disabled={disabled || busy} onChange={(event) => setSrc(event.target.value)} />
    </label>
    <button type="button" className="e-primary" disabled={disabled || busy || !src.trim()} onClick={() => void connect()}>{node.props.refId ? "接続を更新" : "接続"}</button>
    {error && <p className="e-error" role="alert">{error}</p>}
    {node.props.refId && <p className="e-help">URL の形式を確認済みです。公開ページで動作を確認してください。</p>}
    <label className="e-field"><span>背景</span><select disabled={disabled} value={String(node.props.background)} onChange={(event) => setProp("background", event.target.value)}>
      <option value="white">白</option><option value="transparent">透明</option>
    </select></label>
    <label className="e-field"><span>読込前の高さ（px）</span><input type="number" min={240} max={1600} value={Number(node.props.initialHeight)} disabled={disabled}
      onChange={(event) => setProp("initialHeight", Math.min(1600, Math.max(240, Number(event.target.value) || 720)))} /></label>
  </div>;
}

export function managedEditorBlocks(base: string): EditorBlockRegistry {
  return { ManagedEmbed: {
    ...managedEmbedContract,
    label: "NIHO フォーム",
    component: ({ refId, initialHeight }) => <div data-nw-slot="frame" style={{ minHeight: Number(initialHeight) }} role="status">
      {refId ? "NIHO フォーム（公開先で表示）" : "NIHO の埋め込み URL を設定してください。"}
    </div>,
    defaultProps: { background: "white", initialHeight: 720 },
    settings: (props) => <EmbedConnection key={`${props.target.pageId}:${props.target.locale}:${props.node.id}`} {...props} base={base} />
  } };
}
