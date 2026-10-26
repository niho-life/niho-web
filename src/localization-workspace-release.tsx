"use client";

import { useEffect, useRef, useState } from "react";
import { formatDateTime, Icon, useRequests } from "./collection-ui.js";
import {
  parseLocaleReleaseApplyResult, parseLocaleReleasePrepareResult, parseLocaleReleaseStateResult, parseLocalizationOverviewResult,
  type LocaleReleaseBlocker, type LocaleReleaseHistoryEntry, type LocaleReleasePending, type LocaleReleaseProgress, type LocaleReleaseSummary,
  type LocaleReleaseWorkspacePlan, type LocaleReleaseWorkspaceState, type LocalizationOverview, type LocalizationWorkspaceAdapter,
} from "./localization-workspace-model.js";
import { Progress, WorkspaceDialog } from "./localization-workspace-ui.js";

export type ReleaseStart =
  | { readonly kind: "publish" }
  | { readonly kind: "rollback"; readonly target: LocaleReleaseHistoryEntry }
  | { readonly kind: "resume"; readonly pending: LocaleReleasePending };

type Step =
  | { readonly step: "check" }
  | { readonly step: "blocked"; readonly blockers: readonly LocaleReleaseBlocker[] }
  | { readonly step: "start" }
  | { readonly step: "preparing"; readonly progress: LocaleReleaseProgress | null }
  | { readonly step: "confirm"; readonly plan: LocaleReleaseWorkspacePlan }
  | { readonly step: "expired" }
  | { readonly step: "applying"; readonly progress: LocaleReleaseProgress | null }
  | { readonly step: "done"; readonly current: LocaleReleaseSummary }
  | { readonly step: "conflict" }
  | { readonly step: "forbidden" }
  | { readonly step: "stopped"; readonly stage: "check" | "prepare" | "apply"; readonly resumeToken: string | null };

type PageChangeList = NonNullable<LocaleReleaseWorkspacePlan["changes"]>["added"];
/** 公開で新しく出るページと外れるページ。少なければ開いて出す。 */
function PageChanges({ added, removed }: { added: PageChangeList; removed: PageChangeList }) {
  const list = (label: string, pages: PageChangeList) => <details className="lw-previous" open={pages.length > 0 && pages.length <= 10}>
    <summary>{label}（{pages.length}）</summary>
    {pages.length ? <ul>{pages.map((page) => <li key={page.path}>{page.title}<span className="cw-by">　{page.path}</span></li>)}</ul> : <p className="cw-hint">ありません。</p>}
  </details>;
  return <>{list("新しく出るページ", added)}{list("外れるページ", removed)}</>;
}

function FirstReleaseSummary({ summary, target, address, source }: { summary: NonNullable<LocaleReleaseWorkspacePlan["firstRelease"]>; target: string; address: string; source: string }) {
  return <section className="lw-first-release" aria-label="最初の公開の内訳">
    <h3>今回公開するもの</h3>
    <ul>{summary.groups.map((group) => <li key={group.label}><span>{group.label}</span><span>{group.pages} ページ <small>（自動翻訳のまま {group.automaticPages}）</small></span></li>)}</ul>
    <details className="lw-previous"><summary>訳さないページ（{summary.excluded.count}）</summary>
      {summary.excluded.examples.length ? <ul>{summary.excluded.examples.map((page) => <li key={page.path}>{page.title} <span className="cw-by">{page.path} · {page.reason}</span></li>)}</ul> : <p className="cw-hint">{summary.excluded.count ? "詳細は翻訳一覧の対象外で確認できます。" : "ありません。"}</p>}
      {summary.excluded.count > summary.excluded.examples.length && summary.excluded.examples.length > 0 && <p className="cw-hint">ほか {summary.excluded.count - summary.excluded.examples.length} ページは翻訳一覧の対象外で確認できます。</p>}
    </details>
    <p className="cw-hint">{target}版は {new URL(address).pathname} から公開され、ページに言語の切り替えと検索エンジン向けの言語対応が加わります。{source}版のページはそのままです。</p>
  </section>;
}

const MAX_ROUNDS = 1000;
const remaining = (expiresAt: string, now: number) => Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * 言語全体の公開・戻しの手順: 公開できない理由 → 準備（n/m）→ 確認（期限の残り）→ 反映（n/m）。
 * 途中で閉じても、サイトが途中の状態（pending）を持つので、resumeToken で続きから再開できる。
 * confirmationToken はこのダイアログのメモリにだけ持つ。
 */
export function ReleaseDialog({ adapter, start, overview, timeZone, onClose, onOverview, onDone, onOpenItem }: {
  adapter: LocalizationWorkspaceAdapter; start: ReleaseStart; overview: LocalizationOverview; timeZone: string;
  onClose: () => void; onOverview: (overview: LocalizationOverview) => void; onDone: () => void; onOpenItem: (itemKey: string) => void;
}) {
  const requests = useRequests();
  const target = overview.languages.target;
  const operation = start.kind === "resume" ? start.pending.operation : start.kind;
  const rollbackId = start.kind === "rollback" ? start.target.releaseId : start.kind === "resume" ? start.pending.releaseId : null;
  const noun = operation === "rollback" ? "戻し" : "公開";
  const [step, setStep] = useState<Step>(start.kind === "publish" ? { step: "check" } : start.kind === "rollback" ? { step: "start" }
    : start.pending.stage === "prepare" ? { step: "preparing", progress: start.pending.progress } : { step: "applying", progress: start.pending.progress });
  const [now, setNow] = useState(() => Date.now());
  const versions = useRef({ version: overview.version, current: overview.release.current?.version ?? null });

  const prepare = async (resumeToken: string | null) => {
    setStep({ step: "preparing", progress: null });
    let token = resumeToken;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const input = { operation, releaseId: rollbackId, expectedVersion: versions.current.version, expectedCurrentVersion: versions.current.current, resumeToken: token } as const;
      const outcome = await requests.current.run(async (signal) => parseLocaleReleasePrepareResult(await adapter.prepareRelease(input, signal), input));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setStep({ step: "stopped", stage: "prepare", resumeToken: token }); return; }
      const result = outcome.value;
      if (result.status === "preparing") { token = result.resumeToken; setStep({ step: "preparing", progress: result.progress }); continue; }
      if (result.status === "ready") { setNow(Date.now()); setStep({ step: "confirm", plan: result.plan }); return; }
      if (result.status === "blocked") { setStep({ step: "blocked", blockers: result.blockers }); return; }
      setStep({ step: result.status });
      return;
    }
    setStep({ step: "stopped", stage: "prepare", resumeToken: token });
  };
  const apply = async (first: { confirmationToken: string | null; resumeToken: string | null }, prepared: LocaleReleaseSummary | null) => {
    setStep({ step: "applying", progress: null });
    let input = first;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const current = input;
      const outcome = await requests.current.run(async (signal) => parseLocaleReleaseApplyResult(await adapter.applyRelease(current, signal), { prepared }));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setStep({ step: "stopped", stage: "apply", resumeToken: current.resumeToken }); return; }
      const result = outcome.value;
      if (result.status === "applying") { input = { confirmationToken: null, resumeToken: result.resumeToken }; setStep({ step: "applying", progress: result.progress }); continue; }
      if (result.status === "applied") { setStep({ step: "done", current: result.current }); onDone(); return; }
      setStep({ step: result.status });
      return;
    }
    setStep({ step: "stopped", stage: "apply", resumeToken: input.resumeToken });
  };
  const check = async () => {
    setStep({ step: "check" });
    const outcome = await requests.current.run(async (signal) => parseLocalizationOverviewResult(await adapter.loadOverview(signal)));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { setStep({ step: "stopped", stage: "check", resumeToken: null }); return; }
    if (outcome.value.status === "forbidden") { setStep({ step: "forbidden" }); return; }
    const fresh = outcome.value.overview;
    versions.current = { version: fresh.version, current: fresh.release.current?.version ?? null };
    onOverview(fresh);
    setStep(fresh.blockers.length ? { step: "blocked", blockers: fresh.blockers } : { step: "start" });
  };

  useEffect(() => {
    if (start.kind === "publish") void check();
    else if (start.kind === "resume") {
      if (start.pending.stage === "prepare") void prepare(start.pending.resumeToken);
      else void apply({ confirmationToken: null, resumeToken: start.pending.resumeToken }, null);
    }
    // 開いたときに 1 回だけ始める
  }, []);
  const confirming = step.step === "confirm";
  useEffect(() => {
    if (!confirming) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [confirming]);
  useEffect(() => {
    if (step.step === "confirm" && remaining(step.plan.expiresAt, now) <= 0) setStep({ step: "expired" });
  }, [step, now]);

  const title = operation === "rollback" ? `${target}版を前の版に戻す` : `${target}版を公開する`;
  const busy = step.step === "check" || step.step === "preparing" || step.step === "applying";
  let body;
  switch (step.step) {
    case "check": body = <p role="status">公開できるかを確かめています…</p>; break;
    case "blocked": body = <>
      <p className="lw-dialog-lead" role="alert">まだ公開できません。次の {step.blockers.length} 件を直してから、もう一度試してください。</p>
      <ul className="lw-blockers">{step.blockers.map((blocker) => <li key={blocker.id}><span>{blocker.message}</span>
        {blocker.itemKey && <button type="button" className="cw-button" onClick={() => onOpenItem(blocker.itemKey!)}>開く</button>}</li>)}</ul>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button></div>
    </>; break;
    case "start": body = <>
      {operation === "rollback" && start.kind === "rollback"
        ? <p className="lw-dialog-lead">「{start.target.label}」（{formatDateTime(start.target.publishedAt, timeZone)}）に戻します。前に公開した版を、そのまま公開し直します。</p>
        : <p className="lw-dialog-lead">公開できない理由はありません。準備では、公開するページを組み立てて確かめます（まだ公開はしません）。</p>}
      <div className="cw-dialog-actions">
        <button type="button" className="cw-button" onClick={onClose}>やめる</button>
        <button type="button" className="cw-button cw-primary" onClick={() => void prepare(null)}>準備を始める</button>
      </div>
    </>; break;
    case "preparing": body = <>
      <p className="lw-dialog-lead" role="status">{noun}の準備をしています…</p>
      {step.progress && <Progress label="準備" done={step.progress.done} total={step.progress.total} />}
      <p className="cw-hint">閉じても、あとで「続ける」から再開できます。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button></div>
    </>; break;
    case "confirm": {
      const { plan } = step, seconds = remaining(plan.expiresAt, now);
      body = <>
        <p className="lw-dialog-lead">準備ができました。内容を確かめて{noun}してください。</p>
        <dl className="cw-facts lw-plan">
          <div><dt>公開する先</dt><dd className="cw-address">{plan.address}</dd></div>
          <div><dt>ページ数</dt><dd>{plan.pages} ページ</dd></div>
          <div><dt>今の公開中の版</dt><dd>{plan.previous ? `${plan.previous.label}（${formatDateTime(plan.previous.publishedAt, timeZone)}）` : "まだ公開していません"}</dd></div>
          <div><dt>{operation === "rollback" ? "戻す版" : "新しい版"}</dt><dd>{plan.prepared.label}</dd></div>
          <div><dt>確認の期限まで</dt><dd><span role="timer" aria-live="off">残り {clock(seconds)}</span></dd></div>
        </dl>
        {operation === "publish" && plan.previous === null && plan.firstRelease && <FirstReleaseSummary summary={plan.firstRelease} target={target} address={plan.address} source={overview.languages.source} />}
        {plan.changes && operation === "publish" && plan.pages === 0 && <p className="cw-error" role="alert"><Icon name="alert" />{target}版のページをすべて外します。公開すると、{target}版のページは無くなります。</p>}
        {plan.changes && <PageChanges added={plan.changes.added} removed={plan.changes.removed} />}
        <div className="cw-dialog-actions">
          <button type="button" className="cw-button" onClick={onClose}>やめる</button>
          <button type="button" className="cw-button cw-primary" onClick={() => void apply({ confirmationToken: plan.confirmationToken, resumeToken: null }, plan.prepared)}>
            {operation === "rollback" ? "この版に戻す" : `${target}版を公開する`}</button>
        </div>
      </>;
      break;
    }
    case "expired": body = <>
      <p className="lw-dialog-lead" role="alert">確認の期限が切れました。もう一度準備してください。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button>
        <button type="button" className="cw-button cw-primary" onClick={() => void prepare(null)}>準備し直す</button></div>
    </>; break;
    case "applying": body = <>
      <p className="lw-dialog-lead" role="status">{operation === "rollback" ? "戻しています…" : "公開しています…"}</p>
      {step.progress && <Progress label="反映" done={step.progress.done} total={step.progress.total} />}
      <p className="cw-hint">閉じても、あとで「続ける」から再開できます。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button></div>
    </>; break;
    case "done": body = <>
      <p className="lw-dialog-lead" role="status">{operation === "rollback" ? `「${step.current.label}」に戻しました。` : `${target}版を公開しました（${step.current.label}）。`}サイトに出るまで少しかかることがあります。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button cw-primary" onClick={onClose}>閉じる</button></div>
    </>; break;
    case "conflict": body = <>
      <p className="lw-dialog-lead" role="alert">ほかの人が先に{noun}したか、内容が変わりました。読み込み直してから、もう一度試してください。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button>
        {operation === "publish" && <button type="button" className="cw-button cw-primary" onClick={() => void check()}>読み込み直す</button>}</div>
    </>; break;
    case "forbidden": body = <>
      <p className="lw-dialog-lead" role="alert">{noun}する権限がありません。管理者に確かめてください。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button></div>
    </>; break;
    case "stopped": body = <>
      <p className="lw-dialog-lead" role="alert">{step.stage === "apply" ? "反映の途中で止まりました" : step.stage === "prepare" ? "準備の途中で止まりました" : "公開できるかを確かめられませんでした"}。通信を確かめて、続けてください。</p>
      <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button>
        <button type="button" className="cw-button cw-primary" onClick={() => {
          if (step.stage === "check") void check();
          else if (step.stage === "prepare") void prepare(step.resumeToken);
          else if (step.resumeToken) void apply({ confirmationToken: null, resumeToken: step.resumeToken }, null);
          else void prepare(null);
        }}>続ける</button></div>
    </>; break;
  }
  return <WorkspaceDialog title={title} onClose={onClose}><div className="lw-dialog-body" aria-busy={busy}>{body}</div></WorkspaceDialog>;
}

const operationText = { publish: "公開", rollback: "戻し" } as const;

/** 公開の履歴。戻しは履歴から選ぶだけ。 */
export function HistoryDialog({ adapter, overview, timeZone, canRollback, canResume, onClose, onRollback, onResume }: {
  adapter: LocalizationWorkspaceAdapter; overview: LocalizationOverview; timeZone: string; canRollback: boolean; canResume: boolean;
  onClose: () => void; onRollback: (target: LocaleReleaseHistoryEntry) => void; onResume: (pending: LocaleReleasePending) => void;
}) {
  const requests = useRequests();
  const [state, setState] = useState<{ readonly status: "loading" | "error" | "forbidden" } | ({ readonly status: "ready" } & LocaleReleaseWorkspaceState)>({ status: "loading" });
  const load = async () => {
    setState({ status: "loading" });
    const outcome = await requests.current.run(async (signal) => parseLocaleReleaseStateResult(await adapter.readRelease(signal)));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { setState({ status: "error" }); return; }
    setState(outcome.value.status === "forbidden" ? { status: "forbidden" } : outcome.value);
  };
  useEffect(() => { void load(); }, []);
  let body;
  if (state.status !== "ready") body = <div className="lw-dialog-body"><p role={state.status === "loading" ? "status" : "alert"}>{state.status === "loading" ? "履歴を読み込んでいます…" : state.status === "forbidden" ? "履歴を見る権限がありません。" : "履歴を読み込めませんでした。"}</p>
    {state.status === "error" && <button type="button" className="cw-button" onClick={() => void load()}>再試行</button>}</div>;
  else body = <div className="lw-dialog-body">
    {state.pending && <div className="cw-banner lw-inline-banner" role="status"><p>前回の{operationText[state.pending.operation]}が途中です（{state.pending.stage === "apply" ? "反映" : "準備"} {state.pending.progress.done}/{state.pending.progress.total}）。</p>
      {canResume && <button type="button" className="cw-button" onClick={() => onResume(state.pending!)}>続ける</button>}</div>}
    <ol className="lw-history">
      {state.current && <li className="lw-history-row" data-current="true">
        <span className="lw-history-text"><strong>{state.current.label}</strong><span className="cw-by">{formatDateTime(state.current.publishedAt, timeZone)}・{state.current.pages} ページ</span></span>
        <span className="cw-pill" data-status="published"><span className="cw-dot" aria-hidden="true" />公開中</span>
      </li>}
      {state.history.map((entry) => <li key={entry.releaseId} className="lw-history-row">
        <span className="lw-history-text"><strong>{entry.label}</strong>
          <span className="cw-by">{formatDateTime(entry.publishedAt, timeZone)}・{operationText[entry.operation]}{entry.by ? `・${entry.by}` : ""}・{entry.pages} ページ</span></span>
        {canRollback && entry.restorable && <button type="button" className="cw-button" aria-label={`「${entry.label}」に戻す…`} onClick={() => onRollback(entry)}>この版に戻す…</button>}
        {!entry.restorable && <span className="cw-hint">戻せません</span>}
      </li>)}
    </ol>
    {!state.current && state.history.length === 0 && <p className="cw-hint">まだ公開していません。</p>}
    <div className="cw-dialog-actions"><button type="button" className="cw-button" onClick={onClose}>閉じる</button></div>
  </div>;
  return <WorkspaceDialog title={`${overview.languages.target}版の公開の履歴`} onClose={onClose} wide>{body}</WorkspaceDialog>;
}
