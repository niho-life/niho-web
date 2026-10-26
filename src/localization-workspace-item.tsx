"use client";

import { memo, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import { DateTime, Icon, useRequests, type ConfirmRequest } from "./collection-ui.js";
import {
  createOperationId, isSafeNavigationUrl, localizedInputProblem, parseLocalizationCommandResult, parseLocalizationImageResult, parseLocalizationItemResult,
  parseLocalizationJobResult, parseLocalizationTranslationResult, richMarks, richSegments, textSegments,
  type LocalizationCommandInput, type LocalizationImageRejectReason, type LocalizationItem, type LocalizationItemSummary, type LocalizationJob, type LocalizationOverview,
  type LocalizationRichTextUnit, type LocalizationTextUnit, type LocalizationWorkspaceAdapter, type LocalizationWorkspaceUnit, type LocalizedAsset, type LocalizedRichText, type MarkSegment,
  type PreviewOverride,
} from "./localization-workspace-model.js";
import { describeMark, MarkedText, MarkedTextInput, type MarkDescriber } from "./localization-workspace-marks.js";
import { PreviewPane } from "./localization-workspace-preview.js";
import { ItemStateBadge, pause, UnitStateBadge } from "./localization-workspace-ui.js";

type Value = string | LocalizedRichText;
type UnitStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict" | "invalid" | "gone";
type CommandPayload =
  | { readonly action: "adopt-candidate"; readonly candidateId: string }
  | { readonly action: "review-current" | "review-image" | "clear-value" }
  | { readonly action: "set-image"; readonly image: LocalizedAsset | null };
/** 項目ごとの、画面の中の状態（変えるたびに rev を上げて描き直す）。 */
type UnitLive = {
  server: LocalizationWorkspaceUnit;
  segments: MarkSegment[] | null;
  value: Value | null;
  problem: string | null;
  lastValid: MarkSegment[] | null;
  dirty: boolean; seq: number; timer: ReturnType<typeof setTimeout> | undefined; saving: Promise<boolean> | null;
  baseVersion: string; baseSourceVersion: string;
  status: UnitStatus; conflict: "edited" | "source" | null; message: string | null;
  retry: { readonly operationId: string; readonly seq: number } | null;
  actionRetry: { readonly signature: string; readonly operationId: string } | null;
  busy: string | null; actionMessage: { readonly text: string; readonly error: boolean } | null;
  renderKey: number; rev: number;
};
type Live = { item: LocalizationItem | null; units: Map<string, UnitLive>; order: string[]; closed: boolean; uploads: Set<Promise<unknown>> };

const rejectText: Record<LocalizationImageRejectReason | "failed", string> = {
  type: "この種類のファイルは使えません。JPEG・PNG・WebP などの画像を選んでください。", size: "ファイルが大きすぎます。小さくしてから選んでください。",
  permission: "画像を上げる権限がありません。", invalid: "画像を読めませんでした。別のファイルを選んでください。", failed: "画像を上げられませんでした。もう一度試してください。",
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sourceSkeleton(unit: LocalizationTextUnit | LocalizationRichTextUnit): MarkSegment[] {
  if (unit.kind === "text") return textSegments(unit.source).filter((segment) => segment.type === "mark");
  return richSegments(unit.source).filter((segment) => segment.type === "mark");
}
function serverSegments(unit: LocalizationTextUnit | LocalizationRichTextUnit): MarkSegment[] {
  if (unit.value === null) return sourceSkeleton(unit);
  return unit.kind === "text" ? textSegments(unit.value) : richSegments(unit.value);
}
function describerFor(unit: LocalizationWorkspaceUnit): MarkDescriber {
  if (unit.kind === "text") {
    const labels = new Map(unit.marks.map((mark) => [mark.id, mark.label]));
    return (segment) => describeMark(labels.get(segment.id) ?? "印", segment.edge);
  }
  if (unit.kind === "rich-text") {
    const labels = new Map(richMarks(unit.source).map((mark) => [mark.id, mark.label]));
    return (segment) => describeMark(labels.get(segment.id) ?? "飾り", segment.edge, "札");
  }
  return () => ({ text: "", name: "" });
}
function liveFor(server: LocalizationWorkspaceUnit): UnitLive {
  return {
    server, segments: null, value: null, problem: null, lastValid: null, dirty: false, seq: 0, timer: undefined, saving: null,
    baseVersion: server.version, baseSourceVersion: server.sourceVersion, status: "idle", conflict: null, message: null, retry: null, actionRetry: null,
    busy: null, actionMessage: null, renderKey: 0, rev: 0,
  };
}

export type ItemEditorProps = {
  adapter: LocalizationWorkspaceAdapter; overview: LocalizationOverview; itemKey: string; timeZone: string; autosaveDelay: number; pollInterval: number;
  confirm: (request: ConfirmRequest) => void; onSummary: (summary: LocalizationItemSummary) => void; onBack: () => void; onForbidden: () => void; backLabel?: string; hideSourceLink?: boolean;
  registerBack?: (back: (() => void) | null) => void;
};

/** 1 件の編集。項目ごとに原文と訳文を並べ、約 1 秒後に項目ごとに自動で保存する。競合は上書きしない。 */
export function ItemEditor({ adapter, overview, itemKey, timeZone, autosaveDelay, pollInterval, confirm, onSummary, onBack, onForbidden, backLabel = "一覧へ", hideSourceLink = false, registerBack }: ItemEditorProps) {
  const requests = useRequests();
  const baseId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<"loading" | "error" | "forbidden" | "not_found" | "ready">("loading");
  const [, render] = useReducer((count: number) => count + 1, 0);
  const [job, setJob] = useState<LocalizationJob | null>(null);
  const [jobNote, setJobNote] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const [backBusy, setBackBusy] = useState(false);
  const live = useRef<Live>({ item: null, units: new Map(), order: [], closed: false, uploads: new Set() });
  const latest = useRef({ onSummary, onForbidden });
  latest.current = { onSummary, onForbidden };
  const can = (permission: LocalizationOverview["permissions"][number]) => overview.permissions.includes(permission);
  const canEdit = can("edit"), canReview = can("review"), canTranslate = can("translate");

  const touch = (unit: UnitLive) => { unit.rev++; render(); };
  const lose = (status: "forbidden" | "not_found") => {
    const s = live.current;
    s.units.forEach((unit) => clearTimeout(unit.timer));
    s.units.clear(); s.order = []; s.item = null;
    setPhase(status);
    if (status === "forbidden") latest.current.onForbidden();
  };
  /** サーバーの項目を入れる。入力中（dirty）の項目は入力を残す。reset なら入力の中身を作り直す。 */
  const applyServer = (unit: UnitLive, server: LocalizationWorkspaceUnit, reset: boolean) => {
    const changed = !same(unit.server.value, server.value) || unit.server.kind !== server.kind;
    unit.server = server;
    if (!unit.dirty) { unit.baseVersion = server.version; unit.baseSourceVersion = server.sourceVersion; }
    if (reset || (!unit.dirty && changed)) unit.renderKey++;
    unit.rev++;
  };
  const applyItem = (item: LocalizationItem) => {
    const s = live.current, next = new Map<string, UnitLive>();
    for (const server of item.units) {
      const existing = s.units.get(server.unitId);
      if (existing && existing.server.kind === server.kind) { applyServer(existing, server, false); next.set(server.unitId, existing); }
      else next.set(server.unitId, liveFor(server));
    }
    s.units.forEach((unit, unitId) => { if (!next.has(unitId)) clearTimeout(unit.timer); });
    s.units = next; s.order = item.units.map((unit) => unit.unitId); s.item = item;
    render();
  };
  const load = async (quiet: boolean) => {
    if (!quiet) setPhase("loading");
    const outcome = await requests.current.run(async (signal) => parseLocalizationItemResult(await adapter.loadItem({ itemKey }, signal), itemKey));
    if (outcome.kind === "aborted") return false;
    if (outcome.kind === "error") { if (!quiet) setPhase("error"); return false; }
    if (outcome.value.status !== "ready") { lose(outcome.value.status); return false; }
    const item = outcome.value.item;
    applyItem(item);
    latest.current.onSummary({
      key: item.key, groupId: item.groupId, title: item.title, path: item.path, state: item.state, excludedReason: item.excludedReason, totalUnits: item.totalUnits,
      reviewedUnits: item.reviewedUnits, imagesUnreviewed: item.imagesUnreviewed, sourceDraftPending: item.sourceDraftPending, updatedAt: item.updatedAt, updatedBy: item.updatedBy,
    });
    setPhase("ready");
    return true;
  };

  /* ---------- 翻訳の依頼 ---------- */
  const watchJob = async (first: LocalizationJob) => {
    let current = first;
    setJob(current);
    for (let attempt = 0; attempt < 150 && (current.state === "queued" || current.state === "running"); attempt++) {
      if (!(await pause(pollInterval, () => live.current.closed || requests.current.isClosed))) return;
      const jobId = current.jobId;
      const outcome = await requests.current.run(async (signal) => parseLocalizationJobResult(await adapter.readJob({ jobId }, signal), jobId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") continue;
      if (outcome.value.status === "forbidden") { lose("forbidden"); return; }
      if (outcome.value.status === "not_found") { setJob(null); return; }
      current = outcome.value.job;
      setJob(current);
    }
    if (current.state === "done") {
      setJob(null);
      setJobNote({ text: "翻訳案ができました。項目ごとに「翻訳案を使う」で入れられます。", error: false });
      await load(true);
    } else if (current.state === "failed") {
      setJob(null);
      setJobNote({ text: `翻訳案を作れませんでした。${current.message ?? "時間をおいて、もう一度試してください。"}`, error: true });
    }
  };
  const requestTranslation = async () => {
    if (job) return;
    setJobNote(null);
    const operationId = createOperationId();
    const outcome = await requests.current.run(async (signal) => parseLocalizationTranslationResult(await adapter.requestTranslation({ itemKey, operationId, unitIds: null }, signal)));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { setJobNote({ text: "翻訳案を頼めませんでした。もう一度試してください。", error: true }); return; }
    const result = outcome.value;
    if (result.status === "queued") void watchJob(result.job);
    else if (result.status === "invalid") setJobNote({ text: result.message, error: true });
    else lose(result.status);
  };

  useEffect(() => {
    const s = live.current;
    s.closed = false;
    void (async () => {
      if (await load(false)) {
        const pending = live.current.item?.job;
        if (pending && (pending.state === "queued" || pending.state === "running")) void watchJob(pending);
      }
    })();
    return () => { s.closed = true; s.units.forEach((unit) => clearTimeout(unit.timer)); };
    // 開いたときに 1 回だけ読む（key で 1 件ごとに作り直す）
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const s = live.current;
      if (s.uploads.size || [...s.units.values()].some((unit) => unit.dirty || unit.saving)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const focused = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || focused.current) return;
    focused.current = true;
    heading.current?.focus();
  }, [phase]);

  /* ---------- 保存（項目ごと・自動） ---------- */
  const save = async (unitId: string): Promise<boolean> => {
    const s = live.current, unit = s.units.get(unitId);
    if (!unit) return false;
    clearTimeout(unit.timer);
    unit.timer = undefined;
    if (s.closed) return false;
    if (unit.saving) {
      if (!(await unit.saving)) return false;
      return unit.dirty ? save(unitId) : true;
    }
    if (!unit.dirty) return true;
    if (unit.problem || unit.value === null || unit.status === "conflict" || unit.status === "gone") return false;
    const seq = unit.seq, value = unit.value, expectedVersion = unit.baseVersion, expectedSourceVersion = unit.baseSourceVersion;
    const operationId = unit.retry && unit.retry.seq === seq ? unit.retry.operationId : createOperationId();
    unit.status = "saving";
    touch(unit);
    const input: LocalizationCommandInput = { itemKey, operationId, unitId, expectedVersion, expectedSourceVersion, action: "set-value", value };
    const task = (async (): Promise<boolean> => {
      try {
        const outcome = await requests.current.run(async (signal) => parseLocalizationCommandResult(await adapter.command(input, signal), { itemKey, unitId }));
        if (outcome.kind === "aborted") return false;
        if (outcome.kind === "error") { unit.status = "error"; unit.retry = { operationId, seq }; touch(unit); return false; }
        const result = outcome.value;
        unit.retry = null;
        if (result.status === "applied") {
          unit.server = result.unit;
          unit.baseVersion = result.unit.version;
          unit.baseSourceVersion = result.unit.sourceVersion;
          if (unit.seq === seq) { unit.dirty = false; unit.segments = null; unit.value = null; unit.status = "saved"; }
          else unit.status = "pending";
          unit.message = null;
          latest.current.onSummary(result.summary);
          touch(unit);
          return true;
        }
        if (result.status === "conflict") {
          unit.server = result.unit;
          unit.status = "conflict";
          unit.conflict = result.unit.sourceVersion !== expectedSourceVersion ? "source" : "edited";
          latest.current.onSummary(result.summary);
          touch(unit);
          return false;
        }
        if (result.status === "invalid") { unit.status = "invalid"; unit.message = result.message; touch(unit); return false; }
        if (result.status === "not_found") { unit.status = "gone"; touch(unit); return false; }
        lose("forbidden");
        return false;
      } finally { unit.saving = null; }
    })();
    unit.saving = task;
    return task;
  };
  const change = (unitId: string, segments: MarkSegment[]) => {
    const unit = live.current.units.get(unitId);
    if (!unit || unit.server.kind === "image" || !canEdit) return;
    if (!unit.dirty) { unit.baseVersion = unit.server.version; unit.baseSourceVersion = unit.server.sourceVersion; }
    unit.segments = segments; unit.dirty = true; unit.seq++;
    const checked = localizedInputProblem(unit.server, segments);
    clearTimeout(unit.timer);
    if ("message" in checked) { unit.problem = checked.message; unit.value = null; touch(unit); return; }
    unit.problem = null; unit.value = checked.value; unit.lastValid = segments;
    if (unit.status === "invalid") { unit.message = null; }
    if (unit.status === "conflict" || unit.status === "gone") { touch(unit); return; }
    unit.status = "pending";
    unit.timer = setTimeout(() => { void save(unitId); }, autosaveDelay);
    touch(unit);
  };
  const restoreMarks = (unitId: string) => {
    const unit = live.current.units.get(unitId);
    if (!unit || unit.server.kind === "image") return;
    const segments = unit.lastValid ?? serverSegments(unit.server);
    unit.renderKey++;
    if (unit.lastValid || unit.dirty) change(unitId, segments);
    else { unit.segments = null; unit.problem = null; touch(unit); }
  };
  const reloadUnit = (unitId: string) => {
    const unit = live.current.units.get(unitId);
    if (!unit) return;
    clearTimeout(unit.timer);
    Object.assign(unit, { dirty: false, segments: null, value: null, problem: null, lastValid: null, status: "idle", conflict: null, message: null, retry: null,
      baseVersion: unit.server.version, baseSourceVersion: unit.server.sourceVersion });
    unit.renderKey++;
    touch(unit);
  };
  /** 上げている画像と保存待ちを済ませる。全部保存できたら true。 */
  const flushAll = async (): Promise<boolean> => {
    const s = live.current;
    while (s.uploads.size) await Promise.allSettled([...s.uploads]);
    const results = await Promise.all([...s.units.keys()].map(async (unitId) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const unit = s.units.get(unitId);
        if (!unit || !(unit.dirty || unit.saving)) return true;
        if (!(await save(unitId))) return false;
      }
      return !s.units.get(unitId)?.dirty;
    }));
    return results.every(Boolean);
  };

  /* ---------- 項目ごとの操作（確認済み・翻訳案・画像） ---------- */
  const runCommand = async (unitId: string, payload: CommandPayload, success: string) => {
    const unit = live.current.units.get(unitId);
    if (!unit || unit.busy) return;
    // 訳を消すときは、保存していない入力も一緒に捨てる（保存してから消すと、直せない入力で止まる）
    if (payload.action === "clear-value") {
      clearTimeout(unit.timer);
      if (unit.saving) await unit.saving;
      unit.dirty = false; unit.seq++; unit.segments = null; unit.value = null; unit.problem = null; unit.lastValid = null; unit.retry = null;
    } else if (unit.dirty && !(await save(unitId))) {
      unit.actionMessage = { text: "保存できていないため、操作しませんでした。", error: true };
      touch(unit);
      return;
    }
    unit.busy = payload.action;
    unit.actionMessage = null;
    touch(unit);
    try {
      const signature = JSON.stringify([payload, unit.server.version, unit.server.sourceVersion]);
      const operationId = unit.actionRetry?.signature === signature ? unit.actionRetry.operationId : createOperationId();
      const input = { itemKey, operationId, unitId, expectedVersion: unit.server.version, expectedSourceVersion: unit.server.sourceVersion, ...payload } as LocalizationCommandInput;
      const outcome = await requests.current.run(async (signal) => parseLocalizationCommandResult(await adapter.command(input, signal), { itemKey, unitId }));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { unit.actionRetry = { signature, operationId }; unit.actionMessage = { text: "操作できませんでした。もう一度試してください。", error: true }; return; }
      unit.actionRetry = null;
      const result = outcome.value;
      if (result.status === "applied") {
        applyServer(unit, result.unit, payload.action === "adopt-candidate" || payload.action === "clear-value");
        unit.status = "idle";
        unit.actionMessage = { text: success, error: false };
        latest.current.onSummary(result.summary);
      } else if (result.status === "conflict") {
        applyServer(unit, result.unit, true);
        unit.actionMessage = { text: result.unit.sourceVersion !== input.expectedSourceVersion ? "原文が更新されていました。最新を出したので、確かめてからもう一度操作してください。" : "ほかの人が先に直していました。最新を出したので、確かめてからもう一度操作してください。", error: true };
        latest.current.onSummary(result.summary);
      } else if (result.status === "invalid") unit.actionMessage = { text: result.message, error: true };
      else if (result.status === "not_found") unit.status = "gone";
      else lose("forbidden");
    } finally { unit.busy = null; touch(unit); }
  };
  const pickImage = async (unitId: string) => {
    const unit = live.current.units.get(unitId);
    if (!unit || !adapter.pickAsset) return;
    const outcome = await requests.current.run(async (signal) => parseLocalizationImageResult(await adapter.pickAsset!({ itemKey, unitId }, signal)));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { unit.actionMessage = { text: "素材を選べませんでした。もう一度試してください。", error: true }; touch(unit); return; }
    const result = outcome.value;
    if (result.status === "rejected") { unit.actionMessage = { text: rejectText[result.reason], error: true }; touch(unit); return; }
    if (result.status === "cancelled") return;
    await runCommand(unitId, { action: "set-image", image: result.image.asset }, "画像を差し替えました。確かめたら「確認済みにする」を押してください。");
  };
  const uploadImage = async (unitId: string, file: File) => {
    const unit = live.current.units.get(unitId);
    if (!unit || !adapter.uploadImage) return;
    unit.busy = "upload";
    touch(unit);
    const task = requests.current.run(async (signal) => parseLocalizationImageResult(await adapter.uploadImage!({ itemKey, unitId, file }, signal)));
    live.current.uploads.add(task);
    let outcome;
    try { outcome = await task; } finally { live.current.uploads.delete(task); unit.busy = null; touch(unit); }
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { unit.actionMessage = { text: rejectText.failed, error: true }; touch(unit); return; }
    const result = outcome.value;
    if (result.status === "rejected") { unit.actionMessage = { text: rejectText[result.reason], error: true }; touch(unit); return; }
    if (result.status === "cancelled") return;
    await runCommand(unitId, { action: "set-image", image: result.image.asset }, "画像を差し替えました。確かめたら「確認済みにする」を押してください。");
  };

  const clearValue = (unitId: string) => confirm({
    title: "この項目の訳を消しますか", body: "訳文を消して未翻訳に戻します。確認済みの記録も消えます。翻訳案は残ります。", confirmLabel: "訳を消す", tone: "danger",
    run: () => runCommand(unitId, { action: "clear-value" }, "訳を消しました。"),
  });

  const actions = useRef({ change, save, restoreMarks, reloadUnit, runCommand, pickImage, uploadImage, clearValue });
  actions.current = { change, save, restoreMarks, reloadUnit, runCommand, pickImage, uploadImage, clearValue };
  const stable = useRef<UnitActions>({
    change: (id, segments) => actions.current.change(id, segments), retry: (id) => void actions.current.save(id), restoreMarks: (id) => actions.current.restoreMarks(id),
    reload: (id) => actions.current.reloadUnit(id), command: (id, payload, success) => void actions.current.runCommand(id, payload, success),
    pick: (id) => void actions.current.pickImage(id), upload: (id, file) => void actions.current.uploadImage(id, file),
    clear: (id) => actions.current.clearValue(id),
  });

  const back = async () => {
    if (backBusy) return;
    setBackBusy(true);
    const ok = await flushAll();
    setBackBusy(false);
    if (ok) { onBack(); return; }
    confirm({
      title: "保存できていない変更があります", body: `${backLabel}戻ると、この画面でいま直したところのうち、保存できていないものは消えます。`, confirmLabel: "変更を捨てて戻る", tone: "danger",
      run: () => { live.current.units.forEach((unit) => { clearTimeout(unit.timer); unit.dirty = false; }); onBack(); },
    });
  };

  const currentBack = useRef<() => void>(() => {});
  currentBack.current = () => { void back(); };
  useEffect(() => {
    registerBack?.(() => currentBack.current());
    return () => registerBack?.(null);
  }, [registerBack]);

  const s = live.current, item = s.item;
  if (phase !== "ready" || !item) {
    return <div className="cw-editor lw-item">
      <header className="cw-editor-bar"><button type="button" className="cw-back" onClick={onBack}><Icon name="back" /><span className="cw-back-label">{backLabel}</span></button></header>
      <div className="cw-notice" aria-busy={phase === "loading"}>
        <p role={phase === "loading" ? "status" : "alert"}>{phase === "loading" || phase === "ready" ? "読み込んでいます…" : phase === "forbidden" ? "この 1 件を見る権限がありません。管理者に確かめてください。"
          : phase === "not_found" ? "見つかりませんでした。原文から消えたかもしれません。" : "読み込めませんでした。"}</p>
        {phase === "error" && <button type="button" className="cw-button" onClick={() => void load(false)}>再試行</button>}
      </div>
    </div>;
  }

  const units = s.order.map((unitId) => s.units.get(unitId)!).filter(Boolean);
  const anySaving = units.some((unit) => unit.status === "pending" || unit.status === "saving");
  const anyTrouble = units.some((unit) => unit.problem || unit.status === "error" || unit.status === "conflict" || unit.status === "invalid");
  const anySaved = units.some((unit) => unit.status === "saved");
  const saveText = anySaving ? "保存中…" : anyTrouble ? "保存できていない項目があります" : anySaved ? "保存しました" : "";
  // プレビューには、画面が今持っている各項目の訳文を渡す（保存していない入力を含む。材料を読み直さなくても保存後の値が映る）
  const overrides: PreviewOverride[] = units.map((unit) => ({ unitId: unit.server.unitId,
    value: unit.server.kind !== "image" && unit.dirty && unit.value !== null && !unit.problem ? unit.value : unit.server.value }));
  const overridesKey = JSON.stringify(overrides);
  let link: string | null = null;
  try { link = !hideSourceLink && adapter.sourceLink ? adapter.sourceLink(itemKey) : null; } catch { link = null; }
  if (link !== null && !isSafeNavigationUrl(link)) link = null;
  const changed = units.filter((unit) => unit.server.state === "review-needed");
  const rest = units.filter((unit) => unit.server.state !== "review-needed");
  const unitNode = (unit: UnitLive) => <UnitCard key={unit.server.unitId} unit={unit} rev={unit.rev} languages={overview.languages} timeZone={timeZone}
    canEdit={canEdit} canReview={canReview} canPick={!!adapter.pickAsset} canUpload={!!adapter.uploadImage} actions={stable.current} />;
  const sectioned = (list: readonly UnitLive[]) => {
    const nodes: ReactNode[] = [];
    let section: string | null = null;
    list.forEach((unit) => {
      if (unit.server.section !== null && unit.server.section !== section) nodes.push(<h3 key={`section-${unit.server.unitId}`} className="lw-section">{unit.server.section}</h3>);
      section = unit.server.section;
      nodes.push(unitNode(unit));
    });
    return nodes;
  };
  const showPreview = overview.preview !== null && item.previews.length > 0;
  return <div className="cw-editor lw-item">
    <h2 className="cw-sr" tabIndex={-1} ref={heading}>{`「${item.title || "無題"}」の${overview.languages.target}版を直す`}</h2>
    <header className="cw-editor-bar">
      <button type="button" className="cw-back" onClick={() => void back()} disabled={backBusy}><Icon name="back" /><span className="cw-back-label">{backLabel}</span></button>
      <div className="cw-editor-status">
        <span className="lw-item-title">{item.title || "無題"}</span>
        <ItemStateBadge state={item.state} />
        <span className="cw-save-state" role="status">{saveText}</span>
      </div>
      <div className="cw-editor-actions">
        {link && <a className="cw-button" href={link} target="_blank" rel="noopener noreferrer">CMS で開く<span className="cw-sr">（新しいタブで開く）</span></a>}
        {canTranslate && <button type="button" className="cw-button" disabled={!!job} onClick={() => void requestTranslation()}>{job ? "翻訳案を作っています…" : "翻訳案を作る"}</button>}
      </div>
    </header>
    {item.sourceDraftPending && <div className="cw-banner" role="note"><p><strong>{overview.languages.source}の CMS に、まだ公開していない下書きがあります。</strong>翻訳は公開中の{overview.languages.source}をもとにしています。下書きを公開すると、変わった項目が「原文が更新」として出ます。</p>
      {link && <a className="cw-button" href={link} target="_blank" rel="noopener noreferrer">CMS で開く<span className="cw-sr">（新しいタブで開く）</span></a>}</div>}
    {!canEdit && <div className="cw-banner" role="note"><p>訳文を直す権限がありません。見ることだけできます。</p></div>}
    {item.state === "excluded" && item.excludedReason && <div className="cw-banner" role="note"><p>この 1 件は訳しません：{item.excludedReason}</p></div>}
    {job && <div className="cw-banner" role="status"><p>翻訳案を作っています（{job.state === "queued" ? "順番を待っています" : "作っています"}）。できたら項目ごとに出ます。</p></div>}
    {jobNote && <div className="cw-banner" data-tone={jobNote.error ? "error" : "info"} role={jobNote.error ? "alert" : "status"}><p>{jobNote.text}</p>
      <button type="button" className="cw-icon-button" aria-label="知らせを閉じる" onClick={() => setJobNote(null)}><Icon name="close" /></button></div>}
    <div className={`lw-item-body${showPreview ? " lw-with-preview" : ""}`}>
      <div className="lw-units">
        <p className="lw-item-meta">{item.path && <span className="cw-address">{item.path}</span>}<span>確認済み {item.reviewedUnits}/{item.totalUnits}</span>
          {item.updatedAt && <span>最終更新 <DateTime value={item.updatedAt} timeZone={timeZone} />{item.updatedBy ? `・${item.updatedBy}` : ""}</span>}</p>
        {units.length === 0 && <p className="cw-hint">訳す項目はありません。</p>}
        {changed.length > 0 && <section className="lw-changed" aria-labelledby={`${baseId}-changed`}>
          <h3 id={`${baseId}-changed`} className="lw-group-title"><span className="lw-shape" data-lw-state="source-changed" aria-hidden="true" />原文が更新された項目（{changed.length}）</h3>
          <p className="cw-hint">確認した後に原文が変わりました。訳文を直してから、もう一度「確認済みにする」を押してください。</p>
          {sectioned(changed)}
        </section>}
        {rest.length > 0 && <section aria-label="項目">{sectioned(rest)}</section>}
      </div>
      {showPreview && <PreviewPane adapter={adapter} itemKey={itemKey} frameUrl={overview.preview!.frameUrl} previews={item.previews} languages={overview.languages}
        locales={{ source: overview.sourceLocale, target: overview.targetLocale }} overrides={overrides} overridesKey={overridesKey} />}
    </div>
  </div>;
}

type UnitActions = {
  change: (unitId: string, segments: MarkSegment[]) => void; retry: (unitId: string) => void; restoreMarks: (unitId: string) => void; reload: (unitId: string) => void;
  command: (unitId: string, payload: CommandPayload, success: string) => void; pick: (unitId: string) => void; upload: (unitId: string, file: File) => void;
  clear: (unitId: string) => void;
};
type UnitCardProps = {
  unit: UnitLive; rev: number; languages: LocalizationOverview["languages"]; timeZone: string;
  canEdit: boolean; canReview: boolean; canPick: boolean; canUpload: boolean; actions: UnitActions;
};

/** 1 つの項目。原文（読むだけ）と訳文を並べる。 */
const UnitCard = memo(function UnitCard({ unit, languages, timeZone, canEdit, canReview, canPick, canUpload, actions }: UnitCardProps) {
  const baseId = useId();
  const [protectedNote, setProtectedNote] = useState(0);
  const server = unit.server, unitId = server.unitId;
  const describe = describerFor(server);
  const labelId = `${baseId}-label`, targetId = `${baseId}-target`, inputId = `${baseId}-input`, problemId = `${baseId}-problem`, hintId = `${baseId}-hint`;
  const status = unit.status;
  const unitSave = unit.problem ? "保存していません（直すところがあります）" : status === "pending" || status === "saving" ? "保存中…" : status === "saved" ? "保存しました"
    : status === "error" ? "保存できませんでした" : status === "invalid" ? "保存できませんでした" : "";
  const busy = unit.busy !== null;
  const reviewable = server.value !== null && server.state !== "reviewed" && !unit.problem && status !== "conflict" && status !== "gone";
  const conflictBox = status === "conflict" && <div className="lw-conflict" role="alert">
    <p><strong>{unit.conflict === "source" ? "原文が更新されました。" : "ほかの人が先にこの項目を直しました。"}</strong>この項目の入力は保存していません。「最新を読み込む」と、いま直したところは消えます。</p>
    <button type="button" className="cw-button" onClick={() => actions.reload(unitId)}>最新を読み込む</button>
  </div>;
  const goneBox = status === "gone" && <p className="cw-error" role="alert"><Icon name="alert" />この項目は原文から無くなりました。一覧へ戻って開き直してください。</p>;
  const actionNote = unit.actionMessage && <p className={unit.actionMessage.error ? "cw-error" : "lw-note"} role={unit.actionMessage.error ? "alert" : "status"}>
    {unit.actionMessage.error && <Icon name="alert" />}{unit.actionMessage.text}</p>;
  const reviewButton = canReview && reviewable && <button type="button" className="cw-button" disabled={busy}
    onClick={() => actions.command(unitId, { action: server.kind === "image" ? "review-image" : "review-current" }, "確認済みにしました。")}>
    {unit.busy === "review-current" || unit.busy === "review-image" ? "記録しています…" : "確認済みにする"}</button>;
  const clearButton = canEdit && server.kind !== "image" && server.value !== null && status !== "conflict" && status !== "gone"
    && <button type="button" className="cw-link-button" disabled={busy} onClick={() => actions.clear(unitId)}>{unit.busy === "clear-value" ? "消しています…" : "訳を消す"}</button>;

  let target: ReactNode, sourceNode: ReactNode;
  if (server.kind === "image") {
    sourceNode = <span className="lw-image"><img src={server.source.url} alt={`${languages.source}の画像`} loading="lazy" referrerPolicy="no-referrer" /></span>;
    target = <div className="lw-image-target">
      {server.value ? <span className="lw-image"><img src={server.value.url} alt={`${languages.target}の画像`} loading="lazy" referrerPolicy="no-referrer" /></span>
        : <p className="lw-same">{languages.source}と同じ画像を使います。</p>}
      {canEdit && <div className="cw-image-actions">
        {canPick && <button type="button" className="cw-button" disabled={busy || status === "gone"} onClick={() => actions.pick(unitId)}>素材から選ぶ</button>}
        {canUpload && <label className="cw-button lw-file"><input type="file" accept="image/*" className="cw-sr" disabled={busy || status === "gone"} onChange={(event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (file) actions.upload(unitId, file);
        }} />{unit.busy === "upload" ? "上げています…" : "画像を上げる"}</label>}
        {server.value && <button type="button" className="cw-button" disabled={busy || status === "gone"} onClick={() => actions.command(unitId, { action: "set-image", image: null }, `${languages.source}と同じ画像に戻しました。`)}>{languages.source}と同じに戻す</button>}
      </div>}
    </div>;
  } else {
    const segments = unit.segments ?? serverSegments(server);
    sourceNode = <MarkedText segments={server.kind === "text" ? textSegments(server.source) : richSegments(server.source)} describe={describe} />;
    const counter = server.kind === "text" && server.maxLength !== null;
    const length = counter ? [...(unit.segments ? unit.segments : serverSegments(server))].reduce((total, segment) => total + (segment.type === "text" ? [...segment.text].length : 0), 0) : 0;
    const hasMarks = segments.some((segment) => segment.type === "mark");
    target = <>
      <MarkedTextInput id={inputId} labelledBy={`${labelId} ${targetId}`} describedBy={[hasMarks ? hintId : "", unit.problem ? problemId : ""].filter(Boolean).join(" ") || undefined}
        invalid={!!unit.problem} readOnly={!canEdit || status === "gone"} singleLine={server.kind === "text" && server.singleLine}
        segments={segments} renderKey={unit.renderKey} describe={describe} onChange={(next) => actions.change(unitId, next)} onProtected={() => setProtectedNote((count) => count + 1)} />
      {hasMarks && <p className="cw-hint" id={hintId}>札は置き換えてはいけない部分です。消せません。動かすときは切り取って貼り付けます。</p>}
      {protectedNote > 0 && <p className="lw-note" role="status" key={protectedNote}>札は消せません。札の前後の文字だけを直してください。</p>}
      {counter && <span className={`cw-counter${server.kind === "text" && server.maxLength !== null && length > server.maxLength ? " cw-over" : ""}`}>{length} / {server.kind === "text" ? server.maxLength : 0}</span>}
      {unit.problem && <div className="cw-error" id={problemId} role="alert"><Icon name="alert" /><span>{unit.problem}</span>
        {canEdit && <button type="button" className="cw-link-button" onClick={() => actions.restoreMarks(unitId)}>札を元に戻す</button>}</div>}
      {status === "invalid" && unit.message && <p className="cw-error" role="alert"><Icon name="alert" />{unit.message}</p>}
      {server.candidate && !same(server.candidate.value, server.value) && <div className="lw-candidate">
        <span className="lw-col-label">翻訳案</span>
        <MarkedText segments={server.kind === "text" ? textSegments(server.candidate.value as string) : richSegments(server.candidate.value as LocalizedRichText)} describe={describe} />
        {canEdit && <button type="button" className="cw-button" disabled={busy || status === "conflict" || status === "gone"}
          onClick={() => actions.command(unitId, { action: "adopt-candidate", candidateId: server.candidate!.candidateId }, "翻訳案を入れました。確かめたら「確認済みにする」を押してください。")}>
          {unit.busy === "adopt-candidate" ? "入れています…" : "翻訳案を使う"}</button>}
      </div>}
    </>;
  }
  const previous = server.kind !== "image" && server.previousSource !== null && <details className="lw-previous">
    <summary>確認したときの{languages.source}を見る</summary>
    <MarkedText segments={server.kind === "text" ? textSegments(server.previousSource as string) : richSegments(server.previousSource as LocalizedRichText)} describe={describe} />
  </details>;
  return <section className="lw-unit" data-unit-id={unitId} data-state={server.state} aria-labelledby={labelId}>
    <header className="lw-unit-head">
      <h4 id={labelId} className="lw-unit-label">{server.label}{server.required && <span className="cw-required">必須</span>}</h4>
      <UnitStateBadge state={server.state} />
      <span className="cw-save-state lw-unit-save">{unitSave}{status === "error" && <button type="button" className="cw-link-button" onClick={() => actions.retry(unitId)}>再試行</button>}</span>
    </header>
    <div className="lw-pair">
      <div className="lw-source"><span className="lw-col-label">{languages.source}（読むだけ）</span>{sourceNode}{previous}</div>
      <div className="lw-target"><span className="lw-col-label" id={targetId}>{languages.target}</span>{target}</div>
    </div>
    {conflictBox}{goneBox}{actionNote}
    {(reviewButton || clearButton || server.updatedAt) && <footer className="lw-unit-foot">
      {server.updatedAt && <span className="cw-by">最終更新 <DateTime value={server.updatedAt} timeZone={timeZone} />{server.updatedBy ? `・${server.updatedBy}` : ""}</span>}
      {(clearButton || reviewButton) && <span style={{ display: "flex", alignItems: "center", gap: 12, marginInlineStart: "auto" }}>{clearButton}{reviewButton}</span>}
    </footer>}
  </section>;
}, (previous, next) => previous.rev === next.rev && previous.unit === next.unit && previous.canEdit === next.canEdit && previous.canReview === next.canReview
  && previous.languages === next.languages && previous.canPick === next.canPick && previous.canUpload === next.canUpload);
