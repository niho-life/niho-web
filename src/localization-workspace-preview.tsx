"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRequests } from "./collection-ui.js";
import {
  createPreviewNonce, jsonBytes, LOCALIZATION_LIMITS, parseLocalizationPreviewResult, parsePreviewFrameMessage, PREVIEW_MESSAGE_TYPE, PREVIEW_PROTOCOL, previewFrameSrc,
  type LocalizationLocale, type LocalizationPreviewChoice, type LocalizationWorkspaceAdapter, type PreviewOverride, type PreviewRenderMessage,
} from "./localization-workspace-model.js";

type Materials = { readonly status: "loading" | "error" | "too-large" | "forbidden" | "missing" } | { readonly status: "ready"; readonly materials: readonly unknown[] };
type FrameState = { readonly status: "waiting" | "ready" | "rendered" } | { readonly status: "error"; readonly message: string | null };
export type PreviewWidth = "pc" | "360" | "320";
const widths: readonly [PreviewWidth, string][] = [["pc", "PC"], ["360", "360"], ["320", "320"]];
/** 「PC」で描く幅。枠はこの幅で描き、表示の場所が狭ければ縮小して見せる（PC を選んでもスマホの見た目にならないように）。 */
const PC_WIDTH = 1280;
const FRAME_MIN_HEIGHT = 420;
/** 描く幅と、表示の場所の幅から、縮小の倍率と枠の寸法を決める。場所の幅が分からない間は縮小しない。 */
export function previewFrameLayout(width: PreviewWidth, boxWidth: number, viewHeight: number): { readonly frameWidth: number; readonly frameHeight: number; readonly scale: number; readonly boxHeight: number } {
  const frameWidth = width === "pc" ? PC_WIDTH : Number(width);
  const scale = boxWidth > 0 ? Math.min(1, boxWidth / frameWidth) : 1;
  const boxHeight = Math.max(FRAME_MIN_HEIGHT, Math.round(viewHeight * 0.7));
  return { frameWidth, frameHeight: Math.round(boxHeight / scale), scale, boxHeight };
}

/**
 * サイトが用意する描画用の枠に、材料と未保存の入力を postMessage で渡す。
 * 枠は sandbox="allow-scripts"（allow-same-origin なし）なので origin は opaque。送り元（event.source）と nonce で確かめる。
 */
export function PreviewPane({ adapter, itemKey, frameUrl, previews, languages, locales, overrides, overridesKey }: {
  adapter: LocalizationWorkspaceAdapter; itemKey: string; frameUrl: string; previews: readonly LocalizationPreviewChoice[];
  languages: { readonly source: string; readonly target: string }; locales: { readonly source: LocalizationLocale; readonly target: LocalizationLocale };
  overrides: readonly PreviewOverride[]; overridesKey: string;
}) {
  const requests = useRequests();
  const baseId = useId();
  const frame = useRef<HTMLIFrameElement>(null);
  const [nonce] = useState(createPreviewNonce);
  const [previewId, setPreviewId] = useState(previews[0]?.id ?? "");
  const [width, setWidth] = useState<PreviewWidth>("pc");
  // 表示の場所の幅と画面の高さ。枠を描く幅で置き、場所に収まるよう縮小する（previewFrameLayout）
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0), [viewHeight, setViewHeight] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => { setBoxWidth(Math.floor(element.clientWidth)); setViewHeight(window.innerHeight); };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [previews.length]);
  const [language, setLanguage] = useState<"source" | "target">("target");
  const [materials, setMaterials] = useState<Materials>({ status: "loading" });
  const [frameState, setFrameState] = useState<FrameState>({ status: "waiting" });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const latestOverrides = useRef(overrides);
  latestOverrides.current = overrides;

  useEffect(() => {
    if (!previews.some((choice) => choice.id === previewId)) setPreviewId(previews[0]?.id ?? "");
  }, [previews, previewId]);

  useEffect(() => {
    if (!previewId) return;
    const current = ++seq.current;
    setMaterials({ status: "loading" });
    void (async () => {
      const collected: unknown[] = [];
      let cursor: string | null = null, total = 0;
      for (let part = 0; part < LOCALIZATION_LIMITS.previewParts; part++) {
        const outcome = await requests.current.run(async (signal) => parseLocalizationPreviewResult(await adapter.loadPreview({ itemKey, previewId, cursor }, signal)));
        if (outcome.kind === "aborted" || current !== seq.current) return;
        if (outcome.kind === "error") { setMaterials({ status: "error" }); return; }
        if (outcome.value.status === "forbidden") { setMaterials({ status: "forbidden" }); return; }
        if (outcome.value.status === "not_found") { setMaterials({ status: "missing" }); return; }
        total += jsonBytes(outcome.value.material);
        if (total > LOCALIZATION_LIMITS.previewTotalBytes) { setMaterials({ status: "too-large" }); return; }
        collected.push(outcome.value.material);
        cursor = outcome.value.nextCursor;
        if (cursor === null) { setMaterials({ status: "ready", materials: collected }); return; }
      }
      setMaterials({ status: "too-large" });
    })();
  }, [adapter, itemKey, previewId, attempt, requests]);

  // iframe を入れたのと同じタスクで聞き始める（useEffect だと、すぐに読み込まれた枠の ready を取りこぼす）
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const parsed = parsePreviewFrameMessage(event.data, nonce);
      if (!parsed) return;
      if (parsed.event === "error") setFrameState({ status: "error", message: parsed.message });
      else setFrameState((previous) => parsed.event === "ready" ? { status: "ready" } : previous.status === "waiting" ? previous : { status: "rendered" });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce]);

  const waiting = frameState.status === "waiting";
  useEffect(() => {
    // 枠が開けない（読み込みを止められた・ready を送らない）ときは、待ち続けずに知らせる
    if (!waiting) return;
    const timer = setTimeout(() => setFrameState({ status: "error", message: "枠が開けませんでした。" }), 15_000);
    return () => clearTimeout(timer);
  }, [waiting, attempt]);
  const frameReady = !waiting;
  const ready = materials.status === "ready" ? materials.materials : null;
  useEffect(() => {
    if (!frameReady || !ready) return;
    const timer = setTimeout(() => {
      const target = frame.current?.contentWindow;
      if (!target) return;
      const message: PreviewRenderMessage = {
        type: PREVIEW_MESSAGE_TYPE, protocol: PREVIEW_PROTOCOL, nonce, event: "render",
        locale: language === "target" ? locales.target : locales.source, width: width === "pc" ? null : Number(width),
        materials: ready, overrides: language === "target" ? latestOverrides.current : [],
      };
      // 枠は opaque origin なので targetOrigin は "*"。材料には秘密を入れない約束（契約の文書）。
      target.postMessage(message, "*");
    }, 150);
    return () => clearTimeout(timer);
  }, [frameReady, ready, language, width, overridesKey, nonce, locales.source, locales.target]);

  if (!previews.length) return null;
  const layout = previewFrameLayout(width, boxWidth, viewHeight);
  const languageName = language === "target" ? languages.target : languages.source;
  const choice = previews.find((entry) => entry.id === previewId);
  const statusText = materials.status === "loading" ? "プレビューを準備しています…"
    : materials.status === "error" ? "プレビューを読み込めませんでした。"
    : materials.status === "too-large" ? "このページは大きすぎて、プレビューを出せません。"
    : materials.status === "forbidden" ? "プレビューを見る権限がありません。"
    : materials.status === "missing" ? "このページのプレビューはもうありません。"
    : frameState.status === "error" ? `プレビューを表示できませんでした。${frameState.message ?? ""}`
    : frameState.status === "waiting" ? "プレビューの枠を開いています…" : "";
  return <section className="lw-preview" aria-labelledby={`${baseId}-title`}>
    <div className="lw-preview-head">
      <h3 id={`${baseId}-title`}>プレビュー</h3>
      {previews.length > 1 && <label className="lw-preview-page"><span className="cw-sr">表示するページ</span>
        <select className="cw-input" value={previewId} onChange={(event) => setPreviewId(event.target.value)}>{previews.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>}
      <div className="lw-toggle" role="group" aria-label="表示の幅">{widths.map(([value, label]) => <button key={value} type="button" aria-pressed={width === value} onClick={() => setWidth(value)}>{label}</button>)}</div>
      <div className="lw-toggle" role="group" aria-label="表示する言語">
        <button type="button" aria-pressed={language === "source"} onClick={() => setLanguage("source")}>{languages.source}</button>
        <button type="button" aria-pressed={language === "target"} onClick={() => setLanguage("target")}>{languages.target}</button>
      </div>
    </div>
    <p className="lw-preview-note">{language === "target" ? "まだ保存していない入力も映します。" : "原文で表示しています。"}リンクとフォームは動きません。</p>
    {statusText && <p className="lw-preview-status" role="status">{statusText}
      {(materials.status === "error" || frameState.status === "error") && <button type="button" className="cw-link-button" onClick={() => { setFrameState({ status: "waiting" }); setAttempt(attempt + 1); }}>再試行</button>}</p>}
    <div ref={box} className="lw-frame-wrap" data-width={width} data-scale={layout.scale < 1 ? "fit" : undefined}
      style={{ height: layout.boxHeight, overflow: layout.scale < 1 ? "hidden" : undefined }}>
      <iframe ref={frame} key={attempt} className="lw-frame" src={previewFrameSrc(frameUrl, nonce)} sandbox="allow-scripts" referrerPolicy="no-referrer"
        style={{ width: layout.frameWidth, maxWidth: "none", height: layout.frameHeight, minHeight: 0, margin: 0, transform: layout.scale < 1 ? `scale(${layout.scale})` : undefined, transformOrigin: "0 0" }}
        title={`プレビュー：${choice?.label ?? ""}（${languageName}・${width === "pc" ? `PC・${PC_WIDTH}px` : `${width}px`}${layout.scale < 1 ? `・${Math.round(layout.scale * 100)}% で表示` : ""}）`} />
    </div>
  </section>;
}
