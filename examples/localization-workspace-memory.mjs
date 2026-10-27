// 翻訳の画面（LocalizationWorkspace）のデモとテスト用の、メモリ上の adapter。
// データはすべて架空。実在のサイト・人・URL・内部の key は使わない。変更はこのメモリだけで、読み込み直すと戻る。

export const ALL_PERMISSIONS = ["edit", "review", "translate", "publish", "rollback", "settings"];
const T0 = "2026-10-20T09:00:00.000Z";
const M = (id) => `⟦${id}⟧`;

const text = (unitId, label, source, extra = {}) => ({
  unitId, label, section: null, required: true, kind: "text", source, value: null, previousSource: null, candidate: null, marks: [], maxLength: null, singleLine: false,
  version: 1, sourceVersion: "s1", reviewedSource: null, updatedAt: null, updatedBy: null, ...extra,
});
const rich = (unitId, label, children, extra = {}) => ({
  unitId, label, section: null, required: true, kind: "rich-text", source: { kind: "rich-text", children }, value: null, previousSource: null, candidate: null,
  version: 1, sourceVersion: "s1", reviewedSource: null, updatedAt: null, updatedBy: null, ...extra,
});
const image = (unitId, label, url, extra = {}) => ({
  unitId, label, section: null, required: false, kind: "image", source: { asset: { kind: "image-url", src: url }, url }, value: null,
  version: 1, sourceVersion: "s1", reviewedSource: null, updatedAt: null, updatedBy: null, ...extra,
});

/** 架空の 1 件ずつ。key は ID を base64url にしたもの（の形だけをまねた架空の値）。 */
export function seedItems(mediaBase = "https://media.example.test") {
  return [
    {
      key: "aG9tZQ", groupId: "pages", title: "トップ", path: "/", excluded: null, sourceDraftPending: false, updatedAt: "2026-10-24T03:00:00.000Z", updatedBy: "編集担当（架空）",
      previews: [{ id: "home", label: "トップ" }],
      units: [
        text("title", "題名", "海の見える工房", { section: "見出し", singleLine: true, maxLength: 40, value: "Workshop by the sea", editOrigin: "AUTO", updatedAt: "2026-10-24T03:00:00.000Z", updatedBy: "編集担当（架空）" }),
        text("lead", "案内文", `営業時間は${M("m0")}です。お問い合わせは${M("m1")}へ。`, {
          section: "見出し", marks: [{ id: "m0", label: "営業時間" }, { id: "m1", label: "メールアドレス" }],
          candidate: { candidateId: "c-lead-1", value: `Open ${M("m0")}. Contact us at ${M("m1")}.` },
        }),
        rich("body", "本文", [{ type: "text", text: "詳しくは" }, { type: "element", id: "l1", tag: "a", children: [{ type: "text", text: "こちら" }] }, { type: "text", text: "をご覧ください。" }], { section: "本文" }),
        image("cover", "カバー画像", `${mediaBase}/cover-ja.svg`, { section: "本文" }),
      ],
    },
    {
      key: "YWJvdXQ", groupId: "pages", title: "私たちについて", path: "/about", includedParts: ["ページ本文", "案内カード"], relatedItems: [{ key: "aG9tZQ", label: "トップの案内文" }], excluded: null, sourceDraftPending: true, updatedAt: "2026-10-22T03:00:00.000Z", updatedBy: "書き手（架空）",
      previews: [{ id: "about", label: "私たちについて" }],
      units: [
        text("title", "題名", "私たちについて", { singleLine: true, value: "About us", reviewedSource: "s1" }),
        text("intro", "紹介文", "小さな町の工房です。週末は体験教室を開いています。", {
          value: "A small workshop in a small town.", editOrigin: "MANUAL", sourceVersion: "s2", reviewedSource: "s1", previousSource: "小さな町の工房です。",
        }),
      ],
    },
    {
      key: "Zm9vdGVy", groupId: "shared", title: "フッター", path: null, excluded: null, sourceDraftPending: false, updatedAt: "2026-10-18T03:00:00.000Z", updatedBy: "編集担当（架空）",
      previews: [],
      units: [text("copy", "著作権の表示", "海辺の工房（架空）", { singleLine: true, value: "Seaside Workshop (fictional)", reviewedSource: "s1" })],
    },
    {
      key: "bmV3cw", groupId: "posts", title: "お知らせ一覧", path: "/news", excluded: null, sourceDraftPending: false, updatedAt: null, updatedBy: null, previews: [],
      units: [text("title", "題名", "お知らせ", { singleLine: true }), text("empty", "記事が無いときの文", "まだお知らせはありません。")],
    },
    {
      key: "bWVtYmVycw", groupId: "posts", title: "会員向けのお知らせ", path: "/members/news", excluded: "会員だけが読むページなので訳しません。", sourceDraftPending: false,
      updatedAt: null, updatedBy: null, previews: [], units: [],
    },
  ];
}

function unitState(unit) {
  if (unit.value === null) return unit.required ? "missing" : "source";
  if (unit.reviewedSource === unit.sourceVersion) return "reviewed";
  return unit.reviewedSource ? "review-needed" : "draft";
}
function exportUnit(unit) {
  const state = unitState(unit);
  const base = { unitId: unit.unitId, label: unit.label, section: unit.section, required: unit.required, version: `v${unit.version}`, sourceVersion: unit.sourceVersion, state,
    updatedAt: unit.updatedAt, updatedBy: unit.updatedBy, kind: unit.kind, source: structuredClone(unit.source), value: structuredClone(unit.value) };
  if (unit.kind === "image") return base;
  const extra = { previousSource: state === "review-needed" ? structuredClone(unit.previousSource) : null, candidate: structuredClone(unit.candidate), ...(unit.editOrigin ? { editOrigin: unit.editOrigin } : {}) };
  return unit.kind === "text" ? { ...base, ...extra, marks: structuredClone(unit.marks), maxLength: unit.maxLength, singleLine: unit.singleLine } : { ...base, ...extra };
}
function summarize(item) {
  const states = item.units.map(unitState);
  const counted = states.filter((state) => state !== "source");
  const state = item.excluded ? "excluded" : states.includes("missing") ? "untranslated" : states.includes("review-needed") ? "source-changed" : states.includes("draft") ? "draft" : "reviewed";
  return {
    key: item.key, groupId: item.groupId, title: item.title, path: item.path, ...(item.includedParts ? { includedParts: [...item.includedParts] } : {}), state, excludedReason: item.excluded,
    totalUnits: item.excluded ? 0 : counted.length, reviewedUnits: item.excluded ? 0 : counted.filter((entry) => entry === "reviewed").length,
    imagesUnreviewed: item.units.filter((unit, index) => unit.kind === "image" && (states[index] === "draft" || states[index] === "review-needed")).length,
    sourceDraftPending: item.sourceDraftPending, updatedAt: item.updatedAt, updatedBy: item.updatedBy,
  };
}
const marksOf = (value) => [...value.matchAll(/⟦([A-Za-z0-9_-]{1,32})⟧/gu)].map((match) => match[1]).sort().join(",");
const richShape = (value) => {
  const out = [];
  const visit = (nodes, parent) => nodes.forEach((node) => { if (node.type === "element") { out.push(`${parent}:${node.id}:${node.tag}`); visit(node.children, node.id); } });
  visit(value.children, "$root");
  return out.sort().join(",");
};
const richPrefix = (value, prefix) => {
  let first = true;
  const visit = (nodes) => nodes.map((node) => {
    if (node.type === "text") { const text = first ? `${prefix}${node.text}` : node.text; first = false; return { ...node, text }; }
    return { ...node, children: visit(node.children) };
  });
  return { kind: "rich-text", children: visit(value.children) };
};

/**
 * メモリ上の adapter を作る。options:
 * - permissions: できる操作の一覧（既定は全部）
 * - pageSize: 一覧の 1 回の件数（既定 2。段階で返すのを見せるため）
 * - frameUrl: プレビューの枠の URL（無ければプレビューを出さない）
 * - catalogRounds: 原文の取り込みを何回で終えるか（0 なら取り込み済み）
 * - planTtl: 確認の期限（ms・既定 120000）
 * - firstRelease: 初回公開の確認を試す（既定 false）
 * - pending: 途中の公開（"prepare" | "apply"）を作っておく
 * - upload: (file) => Promise<string>（上げた画像の URL）
 * - by: 操作した人の名前
 * - mediaBase: 画像の置き場（既定は https://media.example.test。デモはローカルの /media）
 */
export function createLocalizationMemory(options = {}) {
  const now = () => Date.now();
  const iso = (time = now()) => new Date(time).toISOString();
  const state = {
    permissions: [...(options.permissions ?? ALL_PERMISSIONS)],
    items: seedItems(options.mediaBase),
    groups: [{ id: "pages", label: "固定ページ" }, { id: "shared", label: "共通部分" }, { id: "posts", label: "記事" }],
    overviewVersion: 1,
    blockersOverride: null,
    settings: { version: 1, autoDraft: true, connected: true, waiting: 0, failed: 0, nextRetryAt: null },
    catalog: options.catalogRounds ? { done: 0, total: options.catalogRounds } : null,
    current: options.firstRelease ? null : { releaseId: "en-2026-10-01", version: "r2", label: "10/1 の公開", publishedAt: "2026-10-01T01:00:00.000Z", pages: 3, sharedResources: 1 },
    history: options.firstRelease ? [] : [{ releaseId: "en-2026-09-15", version: "r1", label: "9/15 の公開", publishedAt: "2026-09-15T01:00:00.000Z", pages: 2, sharedResources: 1, operation: "publish", by: "管理者（架空）", restorable: true }],
    pending: null, plan: null, operations: new Map(), jobs: new Map(), releaseCount: options.firstRelease ? 0 : 2, forbidden: false,
  };
  const by = options.by ?? "あなた（架空）";
  const calls = [], holds = new Map(), failures = new Set();
  let tokenCount = 0;
  const token = (prefix) => `${prefix}-${++tokenCount}`;
  if (options.pending) {
    const stage = options.pending;
    state.plan = { operation: "publish", releaseId: null, prepared: { releaseId: "en-2026-10-26", version: "r3", label: "10/26 の公開", publishedAt: iso(), pages: 4, sharedResources: 1 }, confirmationToken: null, expiresAt: now() + 120_000, applyDone: 1 };
    state.pending = { operation: "publish", stage, progress: stage === "apply" ? { done: 1, total: 2 } : { done: 1, total: 3 }, resumeToken: token(stage === "apply" ? "apply" : "prep"), releaseId: null, startedAt: "2026-10-26T00:00:00.000Z", startedBy: "管理者（架空）" };
    state.prepareDone = 1;
  }

  const find = (key) => state.items.find((item) => item.key === key);
  const allowed = (permission) => state.permissions.includes(permission);
  const blockers = () => state.blockersOverride ?? state.items.filter((item) => !item.excluded && summarize(item).state !== "reviewed")
    .map((item) => ({ id: `item-${item.key}`, message: `「${item.title}」に、まだ確認していない項目があります。`, itemKey: item.key }));
  const overview = () => {
    const summaries = state.items.map(summarize);
    return {
      version: `o${state.overviewVersion}`, sourceLocale: "ja", targetLocale: "en", languages: { source: "日本語", target: "English" },
      permissions: [...state.permissions],
      groups: state.groups.map((group) => {
        const list = summaries.filter((summary) => summary.groupId === group.id);
        return { ...group, items: list.length, needsWork: list.filter((summary) => ["untranslated", "draft", "source-changed"].includes(summary.state)).length,
          reviewed: list.filter((summary) => summary.state === "reviewed").length, excluded: list.filter((summary) => summary.state === "excluded").length };
      }),
      release: { current: state.current ? { ...state.current } : null, pending: state.pending ? structuredClone(state.pending) : null },
      blockers: blockers(),
      catalog: state.catalog ? { state: "updating", progress: { ...state.catalog } } : { state: "current" },
      preview: options.frameUrl ? { frameUrl: options.frameUrl } : null,
      settings: settings(),
    };
  };
  const settings = () => ({ version: `set${state.settings.version}`, autoDraft: state.settings.autoDraft, translator: { connected: state.settings.connected },
    queue: { waiting: state.settings.waiting, failed: state.settings.failed, nextRetryAt: state.settings.nextRetryAt } });
  const exportItem = (item) => ({ ...summarize(item), units: item.units.map(exportUnit), previews: structuredClone(item.previews), ...(item.relatedItems ? { relatedItems: structuredClone(item.relatedItems) } : {}), job: null });

  const wrap = (name, run) => async (...args) => {
    const input = args.length > 1 ? args[0] : undefined;
    calls.push({ name, input: input === undefined ? undefined : structuredClone(input) });
    const waiting = holds.get(name);
    if (waiting?.length) {
      if (waiting[0].skip > 0) waiting[0].skip--;
      else await waiting.shift().promise;
    }
    if (failures.has(name)) { failures.delete(name); throw new Error("simulated network failure"); }
    return structuredClone(run(...args));
  };

  const command = (input) => {
    const permission = input.action === "review-current" || input.action === "review-image" ? "review" : "edit";
    if (!allowed(permission)) return { status: "forbidden" };
    if (state.operations.has(input.operationId)) return state.operations.get(input.operationId);
    const item = find(input.itemKey);
    const unit = item?.units.find((entry) => entry.unitId === input.unitId);
    if (!item || !unit) return { status: "not_found" };
    const result = (() => {
      if (input.expectedVersion !== `v${unit.version}` || input.expectedSourceVersion !== unit.sourceVersion) return { status: "conflict", unit: exportUnit(unit), summary: summarize(item) };
      switch (input.action) {
        case "set-value":
          if (unit.kind === "text") {
            if (typeof input.value !== "string" || marksOf(input.value) !== marksOf(unit.source)) return { status: "invalid", message: "置き換えてはいけない部分が原文と合いません。" };
            if (unit.maxLength !== null && [...input.value.replace(/⟦[A-Za-z0-9_-]{1,32}⟧/gu, "")].length > unit.maxLength) return { status: "invalid", message: `${unit.maxLength} 文字以内にしてください。` };
          } else if (unit.kind === "rich-text") {
            if (richShape(input.value) !== richShape(unit.source)) return { status: "invalid", message: "リンクや装飾の形が原文と合いません。" };
          } else return { status: "invalid", message: "画像は画像の操作で変えてください。" };
          unit.value = input.value; unit.editOrigin = "MANUAL"; unit.reviewedSource = unitState(unit) === "reviewed" ? null : unit.reviewedSource;
          break;
        case "adopt-candidate":
          if (!unit.candidate || unit.candidate.candidateId !== input.candidateId) return { status: "invalid", message: "この翻訳案はもう使えません。" };
          unit.value = structuredClone(unit.candidate.value); unit.editOrigin = "AUTO"; unit.reviewedSource = null;
          break;
        case "clear-value":
          if (unit.kind === "image" || unit.value === null) return { status: "invalid", message: "この項目には訳がありません。" };
          unit.value = null; unit.editOrigin = null; unit.reviewedSource = null;
          break;
        case "review-current": case "review-image":
          if (unit.value === null) return { status: "invalid", message: "まだ訳文がありません。" };
          unit.reviewedSource = unit.sourceVersion;
          break;
        case "set-image":
          if (unit.kind !== "image") return { status: "invalid", message: "画像の項目ではありません。" };
          unit.value = input.image ? { asset: structuredClone(input.image), url: input.image.kind === "image-url" ? input.image.src : unit.source.url } : null;
          unit.reviewedSource = null;
          break;
        default: return { status: "invalid", message: "知らない操作です。" };
      }
      unit.version++; unit.updatedAt = iso(); unit.updatedBy = by; item.updatedAt = unit.updatedAt; item.updatedBy = by; state.overviewVersion++;
      return { status: "applied", unit: exportUnit(unit), summary: summarize(item) };
    })();
    state.operations.set(input.operationId, result);
    return result;
  };

  const adapter = {
    loadOverview: wrap("loadOverview", () => state.forbidden ? { status: "forbidden" } : { status: "ready", overview: overview() }),
    listItems: wrap("listItems", ({ cursor }) => {
      const size = options.pageSize ?? 2, start = cursor ? Number(cursor.slice(1)) : 0;
      const items = state.items.slice(start, start + size).map(summarize);
      return { status: "ready", items, nextCursor: start + size < state.items.length ? `p${start + size}` : null };
    }),
    loadItem: wrap("loadItem", ({ itemKey }) => { const item = find(itemKey); return item ? { status: "ready", item: exportItem(item) } : { status: "not_found" }; }),
    command: wrap("command", command),
    requestTranslation: wrap("requestTranslation", ({ itemKey }) => {
      if (!allowed("translate")) return { status: "forbidden" };
      if (!find(itemKey)) return { status: "not_found" };
      const jobId = token("job");
      state.jobs.set(jobId, { itemKey, reads: 0 });
      return { status: "queued", job: { jobId, state: "queued", message: null } };
    }),
    readJob: wrap("readJob", ({ jobId }) => {
      const job = state.jobs.get(jobId);
      if (!job) return { status: "not_found" };
      job.reads++;
      if (job.reads < 2) return { status: "ready", job: { jobId, state: "running", message: null } };
      const item = find(job.itemKey);
      for (const unit of item?.units ?? []) {
        if (unit.kind === "image" || unit.value !== null) continue;
        unit.candidate = { candidateId: token("c"), value: unit.kind === "text" ? `[EN] ${unit.source}` : richPrefix(unit.source, "[EN] ") };
        unit.version++;
      }
      return { status: "ready", job: { jobId, state: "done", message: null } };
    }),
    advanceCatalog: wrap("advanceCatalog", () => {
      if (!allowed("edit")) return { status: "forbidden" };
      if (!state.catalog) return { status: "current" };
      state.catalog.done++;
      if (state.catalog.done >= state.catalog.total) { state.catalog = null; state.overviewVersion++; return { status: "current" }; }
      return { status: "updating", progress: { ...state.catalog } };
    }),
    loadPreview: wrap("loadPreview", ({ itemKey, previewId, cursor }) => {
      const item = find(itemKey);
      if (!item || !item.previews.some((choice) => choice.id === previewId)) return { status: "not_found" };
      if (!cursor) return { status: "ready", material: { part: "page", title: item.title, path: item.path }, nextCursor: "units" };
      return { status: "ready", material: { part: "units", units: item.units.map(exportUnit) }, nextCursor: null };
    }),
    readRelease: wrap("readRelease", () => ({ status: "ready", current: state.current ? { ...state.current } : null, history: structuredClone(state.history), pending: state.pending ? structuredClone(state.pending) : null })),
    prepareRelease: wrap("prepareRelease", (input) => {
      if (!allowed(input.operation === "rollback" ? "rollback" : "publish")) return { status: "forbidden" };
      if (input.resumeToken === null) {
        if (input.expectedVersion !== `o${state.overviewVersion}` || input.expectedCurrentVersion !== (state.current?.version ?? null)) return { status: "conflict" };
        if (input.operation === "publish" && blockers().length) return { status: "blocked", blockers: blockers() };
        const target = input.operation === "rollback" ? state.history.find((entry) => entry.releaseId === input.releaseId && entry.restorable) : null;
        if (input.operation === "rollback" && !target) return { status: "conflict" };
        const prepared = target ? { releaseId: target.releaseId, version: target.version, label: target.label, publishedAt: target.publishedAt, pages: target.pages, sharedResources: target.sharedResources }
          : { releaseId: `en-new-${state.releaseCount + 1}`, version: `r${state.releaseCount + 1}`, label: "今回の公開", publishedAt: iso(), pages: 4, sharedResources: 1 };
        state.plan = { operation: input.operation, releaseId: input.releaseId, prepared, confirmationToken: null, expiresAt: 0, applyDone: 0 };
        state.prepareDone = 1;
        state.pending = { operation: input.operation, stage: "prepare", progress: { done: 1, total: 3 }, resumeToken: token("prep"), releaseId: input.releaseId, startedAt: iso(), startedBy: by };
        return { status: "preparing", progress: { done: 1, total: 3 }, resumeToken: state.pending.resumeToken };
      }
      if (!state.pending || state.pending.stage !== "prepare" || state.pending.resumeToken !== input.resumeToken || !state.plan) return { status: "conflict" };
      state.prepareDone++;
      if (state.prepareDone < 3) {
        state.pending = { ...state.pending, progress: { done: state.prepareDone, total: 3 }, resumeToken: token("prep") };
        return { status: "preparing", progress: { done: state.prepareDone, total: 3 }, resumeToken: state.pending.resumeToken };
      }
      state.plan.confirmationToken = token("confirm");
      state.plan.expiresAt = now() + (options.planTtl ?? 120_000);
      state.pending = null;
      return { status: "ready", plan: { confirmationToken: state.plan.confirmationToken, expiresAt: new Date(state.plan.expiresAt).toISOString(), address: "https://example.test/en/",
        pages: state.plan.prepared.pages, previous: state.current ? { ...state.current } : null, prepared: { ...state.plan.prepared },
        changes: state.plan.operation === "publish" ? structuredClone(options.changes ?? (!state.current
          ? { added: [{ path: "/", title: "トップ" }, { path: "/about", title: "私たちについて" }, { path: "/news", title: "お知らせ一覧" }, { path: "/news/sample", title: "記事の詳細" }], removed: [] }
          : { added: [{ path: "/about", title: "私たちについて" }], removed: [] })) : null,
        firstRelease: state.plan.operation === "publish" && !state.current ? { groups: [{ label: "固定ページ", pages: 2, automaticPages: 1 }, { label: "記事", pages: 2, automaticPages: 2 }],
          excluded: { count: 1, examples: [{ path: "/members/news", title: "会員向けのお知らせ", reason: "会員向け" }] } } : null } };
    }),
    applyRelease: wrap("applyRelease", (input) => {
      const plan = state.plan;
      if (!plan) return { status: "conflict" };
      if (!allowed(plan.operation === "rollback" ? "rollback" : "publish")) return { status: "forbidden" };
      if (input.confirmationToken !== null) {
        if (input.confirmationToken !== plan.confirmationToken) return { status: "conflict" };
        if (now() > plan.expiresAt) return { status: "expired" };
        plan.confirmationToken = null; plan.applyDone = 1;
        state.pending = { operation: plan.operation, stage: "apply", progress: { done: 1, total: 2 }, resumeToken: token("apply"), releaseId: plan.releaseId, startedAt: iso(), startedBy: by };
        return { status: "applying", progress: { done: 1, total: 2 }, resumeToken: state.pending.resumeToken };
      }
      if (!state.pending || state.pending.stage !== "apply" || state.pending.resumeToken !== input.resumeToken) return { status: "conflict" };
      const previous = state.current;
      state.current = { ...plan.prepared };
      state.history = [...(previous ? [{ ...previous, operation: "publish", by: "管理者（架空）", restorable: true }] : []), ...state.history.filter((entry) => entry.releaseId !== plan.prepared.releaseId)];
      if (plan.operation === "publish") state.releaseCount++;
      state.pending = null; state.plan = null; state.overviewVersion++;
      return { status: "applied", current: { ...state.current } };
    }),
    saveSettings: wrap("saveSettings", ({ expectedVersion, autoDraft }) => {
      if (!allowed("settings")) return { status: "forbidden" };
      if (expectedVersion !== `set${state.settings.version}`) return { status: "conflict", settings: settings() };
      state.settings.autoDraft = autoDraft; state.settings.version++;
      return { status: "saved", settings: settings() };
    }),
    pickAsset: wrap("pickAsset", () => {
      const url = `${options.mediaBase ?? "https://media.example.test"}/cover-en.svg`;
      return { status: "picked", image: { asset: { kind: "image-url", src: url }, url } };
    }),
    uploadImage: async (input, signal) => {
      calls.push({ name: "uploadImage", input: { itemKey: input.itemKey, unitId: input.unitId, file: input.file.name } });
      if (input.file.type && !input.file.type.startsWith("image/")) return { status: "rejected", reason: "type" };
      const url = options.upload ? await options.upload(input.file, signal) : `https://media.example.test/upload-${++tokenCount}.png`;
      return { status: "uploaded", image: { asset: { kind: "image-url", src: url }, url } };
    },
    sourceLink: (itemKey) => `https://cms.example.test/items/${itemKey}`,
  };

  return {
    adapter, state, calls,
    named: (name) => calls.filter((call) => call.name === name),
    /** ほかの人が直したことにする（項目の版が上がる）。 */
    externalEdit(itemKey, unitId, value) {
      const unit = find(itemKey).units.find((entry) => entry.unitId === unitId);
      unit.value = value; unit.editOrigin = unit.kind === "image" ? null : "MANUAL"; unit.version++; unit.reviewedSource = null; unit.updatedBy = "ほかの編集者（架空）"; unit.updatedAt = iso(); state.overviewVersion++;
    },
    /** 原文が変わったことにする（原文の版が変わる）。 */
    changeSource(itemKey, unitId, source) {
      const unit = find(itemKey).units.find((entry) => entry.unitId === unitId);
      unit.previousSource = unit.source; unit.source = source; unit.sourceVersion = `s${Number(unit.sourceVersion.slice(1)) + 1}`; state.overviewVersion++;
    },
    setPermissions(list) { state.permissions = [...list]; },
    setBlockers(list) { state.blockersOverride = list; },
    /** 次の（skip 回目の後の）呼び出しを止める。release() で続ける。 */
    hold(name, skip = 0) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      holds.set(name, [...(holds.get(name) ?? []), { promise, skip }]);
      return { release: () => release() };
    },
    failNext(name) { failures.add(name); },
  };
}
