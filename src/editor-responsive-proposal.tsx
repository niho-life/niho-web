"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./editor-dialog.js";
import { editDocument, fingerprint, nodeAt, walkNodes, type EditorOperation } from "./editor-model.js";
import { layerLabel, pathForNodeId } from "./layers.js";
import type {
  EditorBlockRegistry, EditorLock, EditorResponsiveProposalAdapter, EditorResponsiveProposalChange,
  EditorResponsiveProposalProperty, EditorResponsiveProposalRequest, EditorResponsiveProposalResponse, EditorTarget
} from "./editor-types.js";
import type { ComponentLibrary, PageDocument, StyleValue } from "./types.js";
import type { SiteStyles } from "./site-styles.js";

/** 色・内容・状態・演出を除いた、既存style操作で検証できるレスポンシブ項目だけ。 */
export const responsiveProposalProperties = [
  "fontSize", "lineHeight", "letterSpacing", "wordSpacing",
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "display", "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "alignContent",
  "flexGrow", "flexShrink", "flexBasis", "gap", "rowGap", "columnGap",
  "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow",
  "position", "top", "right", "bottom", "left", "overflow", "overflowX", "objectFit"
] as const satisfies readonly EditorResponsiveProposalProperty[];
const allowedProperties = new Set<string>(responsiveProposalProperties);

export class ResponsiveProposalTimeoutError extends Error {
  constructor() { super("レスポンシブ提案が時間内に完了しませんでした。もう一度お試しください。"); this.name = "ResponsiveProposalTimeoutError"; }
}

const abortError = () => new DOMException("Aborted", "AbortError");
/** signalとtimeoutのどちらでも必ず終了する。adapterがabortを無視しても待ち続けない。 */
export async function requestResponsiveProposal(adapter: EditorResponsiveProposalAdapter, request: EditorResponsiveProposalRequest,
  signal: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ResponsiveProposalTimeoutError()); }, timeoutMs); });
  const aborted = new Promise<never>((_, reject) => { abortListener = () => { controller.abort(); reject(abortError()); }; signal.addEventListener("abort", abortListener, { once: true }); });
  try { return await Promise.race([adapter.propose(request, controller.signal), timeout, aborted]); }
  finally { if (timer !== undefined) clearTimeout(timer); if (abortListener) signal.removeEventListener("abort", abortListener); controller.abort(); }
}

type ValidationContext = {
  document: PageDocument;
  request: EditorResponsiveProposalRequest;
  response: unknown;
  blocks?: EditorBlockRegistry;
  locks?: readonly EditorLock[];
  components?: ComponentLibrary;
  siteStyles?: SiteStyles;
};
export type ResponsiveProposalReviewChange = EditorResponsiveProposalChange & {
  before: StyleValue | null;
  after: StyleValue | null;
};
export type ResponsiveProposalReview = {
  response: EditorResponsiveProposalResponse;
  changes: readonly ResponsiveProposalReviewChange[];
  operations: readonly EditorOperation[];
};

const strictRecord = (value: unknown, keys: readonly string[], name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}が正しくありません。`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))) throw new Error(`${name}に未対応の項目があります。`);
  return record;
};
const styleValue = (value: unknown): StyleValue | null => {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return value;
  const token = strictRecord(value, ["token"], "提案の値").token;
  if (typeof token !== "string") throw new Error("提案の値が正しくありません。");
  return { token };
};
const scopeIds = (document: PageDocument, request: EditorResponsiveProposalRequest): Set<string> => {
  if (request.scope.type === "page") return new Set(walkNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
  const path = pathForNodeId(document, request.scope.nodeId);
  if (!path) throw new Error("選択した要素が現在の文書にありません。");
  const root = nodeAt(document, path);
  if (root.type === "text") throw new Error("選択した要素へ見た目を提案できません。");
  return new Set(walkNodes({ ...document, body: [root] }).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
};

/** 未検証のhost応答を閉じたstyle操作へ変換し、全操作を作業コピーへ通してから返す。 */
export function prepareResponsiveProposal(context: ValidationContext): ResponsiveProposalReview {
  const { document, request } = context;
  if (fingerprint(document) !== request.fingerprint) throw new Error("提案後に文書が変更されました。現在の内容でもう一度提案してください。");
  const response = strictRecord(context.response, ["fingerprint", "changes"], "提案の応答");
  if (response.fingerprint !== request.fingerprint) throw new Error("提案の対象文書が一致しません。");
  if (!Array.isArray(response.changes) || response.changes.length > 40) throw new Error("提案の変更数が上限を超えています。");
  const requested = new Set(request.breakpoints), inScope = scopeIds(document, request), duplicate = new Set<string>();
  let probe = document;
  const changes: ResponsiveProposalReviewChange[] = [];
  const operations: EditorOperation[] = [];
  for (const [index, raw] of response.changes.entries()) {
    const change = strictRecord(raw, ["nodeId", "breakpoint", "property", "value"], `提案の変更${index + 1}`);
    if (typeof change.nodeId !== "string" || !inScope.has(change.nodeId)) throw new Error("提案に対象範囲外の要素が含まれています。");
    if (!Number.isInteger(change.breakpoint) || !requested.has(change.breakpoint as number)) throw new Error("提案に依頼していない表示幅が含まれています。");
    if (typeof change.property !== "string" || !allowedProperties.has(change.property)) throw new Error("提案に変更できない見た目が含まれています。");
    const key = JSON.stringify([change.nodeId, change.breakpoint, change.property]);
    if (duplicate.has(key)) throw new Error("提案に同じ変更が重複しています。");
    duplicate.add(key);
    const path = pathForNodeId(probe, change.nodeId);
    if (!path) throw new Error("提案の要素が現在の文書にありません。");
    const node = nodeAt(probe, path);
    if (node.type === "text") throw new Error("テキストノードへ見た目を指定できません。");
    const value = styleValue(change.value), breakpoint = change.breakpoint as number, property = change.property as EditorResponsiveProposalProperty;
    const before = node.style?.responsive?.find((entry) => entry.minWidth === breakpoint)?.declarations[property] ?? null;
    const operation: EditorOperation = { type: "style", path, breakpoint, property, value: value ?? undefined };
    probe = editDocument(probe, operation, context.blocks, context.locks, context.components, context.siteStyles);
    operations.push(operation); changes.push({ nodeId: change.nodeId, breakpoint, property, value, before, after: value });
  }
  return { response: { fingerprint: request.fingerprint, changes: changes.map(({ nodeId, breakpoint, property, value }) => ({ nodeId, breakpoint, property, value })) }, changes, operations };
}

const valueLabel = (value: StyleValue | null) => value === null ? "指定なし" : typeof value === "object" ? `token: ${value.token}` : String(value);
const propertyLabels: Partial<Record<EditorResponsiveProposalProperty, string>> = {
  width: "幅", height: "高さ", minWidth: "最小幅", maxWidth: "最大幅", minHeight: "最小高さ", maxHeight: "最大高さ",
  margin: "外側余白", padding: "内側余白", gap: "要素間隔", rowGap: "行間隔", columnGap: "列間隔",
  display: "表示", flexDirection: "並び方向", flexWrap: "折り返し", justifyContent: "横の配置", alignItems: "縦の配置",
  fontSize: "文字サイズ", lineHeight: "行の高さ", letterSpacing: "字間", position: "配置方法"
};
const nodeLabel = (document: PageDocument, id: string): string => {
  const path = pathForNodeId(document, id);
  if (!path) return id;
  const node = nodeAt(document, path);
  return node.type === "text" ? id : layerLabel(node);
};
type ControlProps = {
  adapter: EditorResponsiveProposalAdapter;
  target: EditorTarget;
  document: PageDocument;
  breakpoints: readonly { minWidth: number; label: string }[];
  selectedNodeId: string | null;
  disabledReason?: string;
  blocks: EditorBlockRegistry;
  locks: readonly EditorLock[];
  components?: ComponentLibrary;
  siteStyles?: SiteStyles;
  onOpenChange?(open: boolean): void;
  apply(operations: readonly EditorOperation[]): string | undefined;
};
type Phase = { type: "configure" } | { type: "pending" } | { type: "error"; message: string } |
  { type: "review"; request: EditorResponsiveProposalRequest; response: unknown; review: ResponsiveProposalReview };

export function ResponsiveProposalControl(props: ControlProps) {
  const [open, setOpen] = useState(false), [scope, setScope] = useState<"page" | "node">(props.selectedNodeId ? "node" : "page");
  const [widths, setWidths] = useState<readonly number[]>(props.breakpoints.map((entry) => entry.minWidth));
  const [phase, setPhase] = useState<Phase>({ type: "configure" });
  const request = useRef<AbortController | null>(null), root = useRef<HTMLSpanElement>(null);
  const identity = `${props.target.siteId}\u0000${props.target.pageId}\u0000${props.target.locale}\u0000${fingerprint(props.document)}`;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity; request.current?.abort(); request.current = null;
    if (open) setPhase({ type: "error", message: "対象または文書が変更されました。ダイアログを閉じ、現在の内容でもう一度提案してください。" });
  }, [identity, open]);
  useEffect(() => () => { request.current?.abort(); props.onOpenChange?.(false); }, []);
  const close = () => { request.current?.abort(); request.current = null; setOpen(false); props.onOpenChange?.(false); setPhase({ type: "configure" }); };
  const start = async () => {
    if (props.disabledReason || !widths.length || scope === "node" && !props.selectedNodeId) return;
    const source = props.document, sourceFingerprint = fingerprint(source);
    const proposalRequest: EditorResponsiveProposalRequest = {
      target: { ...props.target }, document: structuredClone(source), fingerprint: sourceFingerprint,
      scope: scope === "node" ? { type: "node", nodeId: props.selectedNodeId! } : { type: "page" }, breakpoints: [...widths]
    };
    const controller = new AbortController(); request.current?.abort(); request.current = controller; setPhase({ type: "pending" });
    let response: unknown;
    try {
      response = await requestResponsiveProposal(props.adapter, proposalRequest, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted || error instanceof ResponsiveProposalTimeoutError) setPhase({ type: "error", message: error instanceof ResponsiveProposalTimeoutError ? error.message : "レスポンシブ提案を取得できませんでした。接続と権限を確認して再試行してください。" });
      return;
    } finally { if (request.current === controller) request.current = null; }
    if (controller.signal.aborted) return;
    try {
      const review = prepareResponsiveProposal({ document: props.document, request: proposalRequest, response, blocks: props.blocks, locks: props.locks,
        ...(props.components ? { components: props.components } : {}), ...(props.siteStyles ? { siteStyles: props.siteStyles } : {}) });
      setPhase({ type: "review", request: proposalRequest, response, review });
    } catch (error) {
      setPhase({ type: "error", message: error instanceof Error ? error.message : "レスポンシブ提案を確認できませんでした。" });
    }
  };
  const apply = () => {
    if (phase.type !== "review") return;
    try {
      const current = prepareResponsiveProposal({ document: props.document, request: phase.request, response: phase.response, blocks: props.blocks, locks: props.locks,
        ...(props.components ? { components: props.components } : {}), ...(props.siteStyles ? { siteStyles: props.siteStyles } : {}) });
      if (!current.operations.length) { setPhase({ type: "error", message: "適用できる変更がありません。" }); return; }
      const problem = props.apply(current.operations);
      if (problem) { setPhase({ type: "error", message: problem }); return; }
      close();
    } catch (error) { setPhase({ type: "error", message: error instanceof Error ? error.message : "提案を適用できませんでした。" }); }
  };
  return <span ref={root} className="e-responsive-proposal-control">
    <button type="button" className="e-small" disabled={!!props.disabledReason || !props.breakpoints.length} title={props.disabledReason ?? "現在の文書から幅別スタイルの提案を作成"}
      onClick={() => { setScope(props.selectedNodeId ? "node" : "page"); setWidths(props.breakpoints.map((entry) => entry.minWidth)); setPhase({ type: "configure" }); setOpen(true); props.onOpenChange?.(true); }}>レスポンシブ提案</button>
    {props.disabledReason && <small className="e-responsive-proposal-hint">{props.disabledReason}</small>}
    {open && createPortal(<Dialog name="レスポンシブ提案" dismiss={close}><h2>レスポンシブ提案</h2>
      {phase.type === "configure" && <><p className="e-help">ホストが現在の文書を使って提案します。内容・構造・リンクは変更せず、選んだ幅のレイアウト、余白、サイズだけを確認後に適用します。</p>
        <fieldset className="e-responsive-proposal-options"><legend>対象</legend>
          <label><input type="radio" name="responsive-scope" checked={scope === "node"} disabled={!props.selectedNodeId} autoFocus={!!props.selectedNodeId} onChange={() => setScope("node")} />選択中の要素とその内側</label>
          <label><input type="radio" name="responsive-scope" checked={scope === "page"} autoFocus={!props.selectedNodeId} onChange={() => setScope("page")} />ページ全体</label>
        </fieldset><fieldset className="e-responsive-proposal-options"><legend>提案する幅（1つ以上）</legend>{props.breakpoints.map((entry) => <label key={entry.minWidth}><input type="checkbox" checked={widths.includes(entry.minWidth)} onChange={(event) => setWidths((current) => event.target.checked ? [...current, entry.minWidth].sort((a, b) => a - b) : current.filter((width) => width !== entry.minWidth))} />{entry.label}（{entry.minWidth}px以上）</label>)}</fieldset>
        {!widths.length && <p role="alert" className="problem">提案する幅を1つ以上選んでください。</p>}
        <div className="e-actions"><button type="button" onClick={close}>キャンセル</button><button type="button" className="e-primary" disabled={!widths.length || scope === "node" && !props.selectedNodeId} onClick={() => void start()}>提案を依頼</button></div></>}
      {phase.type === "pending" && <><p role="status">提案を作成しています…</p><p className="e-help">30秒で終了します。文書はまだ変更されていません。</p><div className="e-actions"><button type="button" autoFocus onClick={close}>キャンセル</button></div></>}
      {phase.type === "error" && <><p role="alert" className="problem">{phase.message}</p><p className="e-help">文書は変更されていません。</p><div className="e-actions"><button type="button" autoFocus onClick={close}>閉じる</button></div></>}
      {phase.type === "review" && <><p className="e-help">次の変更だけを1回の編集履歴として適用します。適用後は「元に戻す」でまとめて戻せます。</p>
        {phase.review.changes.length ? <table className="e-responsive-proposal-review"><thead><tr><th>要素</th><th>幅</th><th>項目</th><th>変更前</th><th>変更後</th></tr></thead><tbody>{phase.review.changes.map((change) => <tr key={`${change.nodeId}/${change.breakpoint}/${change.property}`}><td title={change.nodeId}>{nodeLabel(props.document, change.nodeId)}</td><td>{change.breakpoint}px以上</td><td>{propertyLabels[change.property] ?? change.property}</td><td>{valueLabel(change.before)}</td><td>{valueLabel(change.after)}</td></tr>)}</tbody></table> : <p role="status">変更の提案はありませんでした。</p>}
        <div className="e-actions"><button type="button" autoFocus onClick={close}>キャンセル</button><button type="button" className="e-primary" disabled={!phase.review.changes.length} onClick={apply}>この変更を適用</button></div></>}
    </Dialog>, root.current?.closest(".nw-editor") ?? window.document.body)}
  </span>;
}

export const responsiveProposalCss = `
.nw-editor .e-responsive-proposal-control{display:inline-flex;align-items:center;gap:6px;min-width:0}.nw-editor .e-responsive-proposal-hint{max-width:180px;color:var(--e-muted);font-size:var(--nw-font-size-sub);line-height:1.25}.nw-editor .e-responsive-proposal-options{display:flex;flex-direction:column;gap:8px;margin:14px 0;padding:12px;border:1px solid var(--e-border);border-radius:var(--nw-radius-lg)}.nw-editor .e-responsive-proposal-options legend{padding:0 4px;font-size:12px;font-weight:700}.nw-editor .e-responsive-proposal-options label{display:flex;align-items:center;gap:8px;font-size:13px}.nw-editor .e-responsive-proposal-review td:first-child{max-width:150px}.nw-editor .e-responsive-proposal-review td{word-break:break-word}
`;
