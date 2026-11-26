"use client";

import { LocalizationItemWorkspace, type LocalizationWorkspaceAdapter } from "../src/localization-workspace.js";
import type { LocalizationCommandInput } from "../src/localization-workspace-model.js";
import { useState } from "react";

const adapters = new Map<string, LocalizationWorkspaceAdapter>();
type CmsReleasePlan = {
  readonly operationId: string;
  readonly confirmationToken: string;
  readonly expiresAt: string;
};

function adapterFor(projectId: string, siteId: string): LocalizationWorkspaceAdapter {
  const key = `${projectId}/${siteId}`, current = adapters.get(key);
  if (current) return current;
  const base = `/api/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/cms/v2`;
  async function call(operation: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const operationId = typeof input.operationId === "string" ? input.operationId : undefined;
    const response = await fetch(`${base}/${operation}`, { method: "POST", cache: "no-store", ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json", ...(operationId ? { "X-Studio-Operation-Key": operationId } : {}) },
      body: JSON.stringify({ siteId, ...input }) });
    const value = await response.json().catch(() => null);
    if (response.status === 403) return { status: "forbidden" };
    if (response.status === 404) return { status: "not_found" };
    if (response.status === 409 && value?.status === "conflict") return value;
    if (!response.ok || value === null) throw new Error("CMS localization request failed");
    return value;
  }
  const adapter: LocalizationWorkspaceAdapter = {
    loadOverview: (signal) => call("cms.localization.overview", {}, signal),
    listItems: (_input, signal) => call("cms.localization.items.list", {}, signal),
    loadItem: ({ itemKey }, signal) => call("cms.localization.items.read", { itemKey }, signal),
    async command(input: LocalizationCommandInput, signal) {
      const result = await call("cms.localization.items.command", input as unknown as Record<string, unknown>, signal);
      if (result?.status !== "applied" && result?.status !== "conflict") return result;
      const current = await call("cms.localization.items.read", { itemKey: input.itemKey }, signal);
      if (current?.status !== "ready" || !current.item) throw new Error("CMS localization item refresh failed");
      return { ...result, item: current.item };
    },
    async requestTranslation() { return { status: "invalid", message: "Studio CMS の自動翻訳サービスは未接続です。訳文を入力してください。" }; },
    async readJob({ jobId }) { return { status: "ready", job: { jobId, state: "failed", message: "この項目に翻訳ジョブはありません。" } }; },
    async advanceCatalog() { return { status: "current" }; },
    async loadPreview() { return { status: "not_found" }; },
    async readRelease() { return { status: "ready", current: null, history: [], pending: null }; },
    async prepareRelease() { return { status: "blocked", blockers: [{ code: "translation_incomplete", message: "CMS locale 公開は CMS の公開操作から行ってください。" }] }; },
    async applyRelease() { return { status: "expired" }; },
    async saveSettings() { return { status: "invalid", message: "Studio CMS 翻訳設定は変更できません。" }; }
  };
  adapters.set(key, adapter);
  return adapter;
}

export function ManagedCmsTranslation({ projectId, siteId, itemKey, onBack, registerBack }: {
  readonly projectId: string; readonly siteId: string; readonly itemKey: string;
  readonly onBack: () => void; readonly registerBack: (back: (() => void) | null) => void;
}) {
  const [plan, setPlan] = useState<{ readonly plan: CmsReleasePlan; readonly locale: string; readonly includedItems: number;
    readonly omittedItems: readonly { readonly collectionId: string; readonly missingFieldIds: readonly string[] }[] } | null>(null);
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState("");
  async function callRelease(operation: string, input: Record<string, unknown>) {
    const base = `/api/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/cms/v2`;
    const operationId = typeof input.operationId === "string" ? input.operationId : undefined;
    const response = await fetch(`${base}/${operation}`, { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(operationId ? { "X-Studio-Operation-Key": operationId } : {}) },
      body: JSON.stringify({ siteId, ...input }) });
    const value = await response.json().catch(() => null);
    if (!response.ok || value === null) throw new Error(value?.problems?.[0]?.message ?? "CMS の翻訳公開を準備できませんでした。");
    return value;
  }
  async function prepareRelease() {
    setBusy(true); setFeedback("");
    try {
      const result = await callRelease("cms.localization.release.plan", {});
      if (result.status !== "ready" || typeof result.plan?.operationId !== "string" || typeof result.plan?.confirmationToken !== "string") {
        throw new Error("CMS の翻訳公開を準備できませんでした。訳文と公開ルートを確認してください。");
      }
      setPlan({ plan: result.plan, locale: result.locale, includedItems: result.includedItems, omittedItems: result.omittedItems });
    } catch (error) { setFeedback(error instanceof Error ? error.message : "CMS の翻訳公開を準備できませんでした。"); }
    finally { setBusy(false); }
  }
  async function applyRelease() {
    if (!plan) return;
    setBusy(true); setFeedback("");
    try {
      const result = await callRelease("cms.localization.release.apply", { operationId: plan.plan.operationId, confirmationToken: plan.plan.confirmationToken });
      if (result.status !== "published") throw new Error("CMS の翻訳公開を反映できませんでした。内容を更新して再計画してください。");
      setFeedback(`${plan.locale === "en" ? "English" : "日本語"} CMS snapshot を公開しました。公開項目 ${result.result.itemCount} 件。`);
      setPlan(null);
    } catch (error) { setFeedback(error instanceof Error ? error.message : "CMS の翻訳公開を反映できませんでした。"); }
    finally { setBusy(false); }
  }
  return <section aria-label="CMS 項目の翻訳">
    <div className="studio-site-hub-actions">
      <button type="button" disabled={busy} onClick={() => void prepareRelease()}>{busy ? "公開計画を作成しています…" : "翻訳済み CMS を公開"}</button>
    </div>
    {feedback && <p role="status">{feedback}</p>}
    {plan && <section aria-label="CMS 翻訳公開の確認">
      <h2>{plan.locale === "en" ? "English" : "日本語"} CMS snapshot</h2>
      <p>公開対象 {plan.includedItems} 件。未完了の項目 {plan.omittedItems.length} 件はこの snapshot から省略され、日本語を代わりに出しません。</p>
      {plan.omittedItems.length > 0 && <ul aria-label="省略する項目">
        {plan.omittedItems.map((item, index) => <li key={`${item.collectionId}/${index}`}>{item.collectionId}：訳文未完了</li>)}
      </ul>}
      <div className="studio-site-hub-actions">
        <button type="button" disabled={busy} onClick={() => void applyRelease()}>この内容を公開</button>
        <button type="button" disabled={busy} onClick={() => setPlan(null)}>計画を破棄</button>
      </div>
    </section>}
    <LocalizationItemWorkspace adapter={adapterFor(projectId, siteId)} itemKey={itemKey} onBack={onBack} registerBack={registerBack} showReviewCurrent />
  </section>;
}
