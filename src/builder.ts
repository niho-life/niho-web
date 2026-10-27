import { parsePageDocument } from "./document.js";
import { walkNodes, type NodePath } from "./node-tree.js";
import { carouselPreset, togglePreset, videoWithButtonPreset } from "./interaction-presets.js";
import { stateNames, stateProperties } from "./style-values.js";
import type { SiteStyles } from "./site-styles.js";
import type {
  Appear, BlockContracts, ComponentLibrary, ElementNode, EmbedProvider, NodeStyle, PageDocument, PageNode, StateDeclarations, StateName, StyleProperty, StyleValue
} from "./types.js";

/** プリセットが作る全ノード ID の採番口。呼ぶたびに文書内で未使用の ID を返す。 */
export type BuilderIdFactory = () => string;
export type InsertionContext = {
  id: BuilderIdFactory;
  target: Readonly<Pick<PageDocument, "siteId" | "pageId" | "locale">>;
};
export type InsertionCategory = "basic" | "parts" | "sections";
/** trusted host が通常の PageNode 部分木を返す。関数自体は文書へ保存されない。 */
export type InsertionPreset = {
  id: string;
  label: string;
  description?: string;
  group: string;
  /** 省略した既存・host独自プリセットは basic として表示する。 */
  category?: InsertionCategory;
  glyph?: string;
  create(context: InsertionContext): PageNode;
};

export type MotionBaseProperty = Extract<StyleProperty,
  "translate" | "rotate" | "scale" | "skew" | "transformOrigin" |
  "transitionDuration" | "transitionDelay" | "transitionTimingFunction">;
/** NodeStyle のうち動きに関係する閉じた領域だけ。responsive・hidden・任意 CSS は受け取らない。 */
export type MotionStylePatch = {
  base?: Partial<Record<MotionBaseProperty, StyleValue>>;
  states?: Partial<Record<StateName, StateDeclarations>>;
  appear?: Appear;
};
export type MotionPreset = { id: string; label: string; description?: string; style: MotionStylePatch };
export type BuilderDefinition = {
  insertions?: readonly InsertionPreset[];
  motions?: readonly MotionPreset[];
};

export type InsertionBuildOptions = {
  document: PageDocument;
  blocks?: BlockContracts;
  components?: ComponentLibrary;
  siteStyles?: SiteStyles;
  /** undefined は全登録ブロック、空配列は新規ブロック禁止。 */
  insertableBlocks?: readonly string[];
  /** 共通部品の編集中など、ホスト固有の配置制約を追加する。 */
  canInsertInstance?: (componentId: string) => boolean;
  /** PageEditor の既存 ID 形式を維持するための接頭辞。 */
  idPrefix?: string;
};

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const motionBaseProperties: readonly MotionBaseProperty[] = [
  "translate", "rotate", "scale", "skew", "transformOrigin", "transitionDuration", "transitionDelay", "transitionTimingFunction"
];
export const MOTION_BASE_PROPERTIES: readonly MotionBaseProperty[] = motionBaseProperties;
const appearFields = ["effect", "trigger", "duration", "delay", "easing"] as const;

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function closed(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(message);
  return value;
}
/** TypeScriptを経由しないhost定義も、NodeStyleのモーション用closed領域だけに制限する。値は文書validatorが別途検査する。 */
export function assertMotionStylePatch(value: unknown): asserts value is MotionStylePatch {
  const source = closed(value, ["base", "states", "appear"], "モーションプリセットのstyleが正しくありません。");
  if (source.base !== undefined) closed(source.base, motionBaseProperties, "モーションプリセットのbaseに未対応の見た目があります。");
  if (source.states !== undefined) {
    const entries = closed(source.states, stateNames, "モーションプリセットの状態が正しくありません。");
    for (const declarations of Object.values(entries)) closed(declarations, stateProperties, "モーションプリセットの状態に未対応の見た目があります。");
  }
  if (source.appear !== undefined) closed(source.appear, appearFields, "モーションプリセットの登場設定が正しくありません。");
  const hasBase = source.base !== undefined && Object.keys(source.base as Record<string, unknown>).length > 0;
  const hasStates = source.states !== undefined && Object.keys(source.states as Record<string, unknown>).length > 0;
  if (!hasBase && !hasStates && source.appear === undefined) throw new Error("モーションプリセットのstyleが空です。");
}

const element = (id: BuilderIdFactory, tag: ElementNode["tag"], text?: string): ElementNode => ({
  type: "element", id: id(), tag,
  ...(tag === "a" ? { attrs: { href: "/" } } : tag === "img" ? { attrs: { src: "/placeholder.webp", alt: "画像の説明" } }
    : tag === "video" ? { attrs: { "aria-label": "動画", controls: true, preload: "metadata", playsInline: true } } : {}),
  children: tag === "img" || tag === "video" ? [] : text === undefined ? [] : [{ type: "text", text }]
});
const icon = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "span", icon: "check", attrs: { role: "img", "aria-label": "チェック" },
  style: { base: { display: "inline-flex", fontSize: 32, color: "currentColor", lineHeight: 1 } }, children: []
});
const richText = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "div", attrs: { role: "group", "aria-label": "リッチテキスト" }, children: [element(id, "p", "新しいテキスト")]
});
const embed = (id: BuilderIdFactory, provider: EmbedProvider, title: string): ElementNode => ({
  type: "element", id: id(), tag: "div", embed: { provider, title },
  style: { base: { width: "100%", height: 360, overflow: "hidden", borderRadius: 8, backgroundColor: "#f2f2f2" } }, children: []
});
const list = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "ul", children: ["項目 1", "項目 2", "項目 3"].map((value) => element(id, "li", value))
});
const stack = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "div", style: { base: { display: "flex", gap: 16, alignItems: "center" } },
  children: [element(id, "div"), element(id, "div")]
});
const grid = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "div", style: { base: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 } },
  children: [element(id, "div"), element(id, "div")]
});
const styled = (id: BuilderIdFactory, tag: ElementNode["tag"], children: PageNode[], style?: NodeStyle, attrs?: ElementNode["attrs"]): ElementNode => ({
  type: "element", id: id(), tag, ...(attrs ? { attrs } : {}), ...(style ? { style } : {}), children
});
const link = (id: BuilderIdFactory, label: string, style?: NodeStyle): ElementNode => styled(id, "a", [{ type: "text", text: label }], style, { href: "/" });
const column = (gap = 12): NodeStyle => ({ base: { display: "flex", flexDirection: "column", gap } });
const responsiveRow: NodeStyle = {
  base: { display: "flex", flexDirection: "column", gap: 20 },
  responsive: [{ minWidth: 768, declarations: { flexDirection: "row", alignItems: "center" } }]
};
const formControlStyle: NodeStyle = { base: { width: "100%", padding: "10px 12px", borderWidth: 1, borderStyle: "solid", borderColor: "#c9c9c9", borderRadius: 6 } };
const formLabelStyle: NodeStyle = { base: { display: "flex", flexDirection: "column", gap: 6, fontWeight: 600 } };
const formShell = (id: BuilderIdFactory, name: string, children: PageNode[]): ElementNode => styled(id, "form", children, {
  base: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 640, padding: 24, borderWidth: 1, borderStyle: "solid", borderColor: "#dedede", borderRadius: 12 }
}, { name, autocomplete: "on", "aria-label": "入力フォーム" });
const formInput = (id: BuilderIdFactory, labelText: string, name: string, type: string = "text", placeholder?: string, required = false): PageNode[] => {
  const inputId = id();
  return [styled(id, "label", [{ type: "text", text: labelText }], formLabelStyle, { htmlFor: inputId }), {
    type: "element", id: inputId, tag: "input", attrs: { id: inputId, type, name, ...(placeholder ? { placeholder } : {}), ...(required ? { required: true } : {}) }, style: formControlStyle, children: []
  }];
};
const formTextarea = (id: BuilderIdFactory, labelText: string, name: string, placeholder: string): PageNode[] => {
  const controlId = id();
  return [styled(id, "label", [{ type: "text", text: labelText }], formLabelStyle, { htmlFor: controlId }), {
    type: "element", id: controlId, tag: "textarea", attrs: { id: controlId, name, placeholder, rows: 5 }, style: formControlStyle, children: []
  }];
};
const formSelect = (id: BuilderIdFactory, labelText: string, name: string, choices: readonly string[]): PageNode[] => {
  const controlId = id();
  return [styled(id, "label", [{ type: "text", text: labelText }], formLabelStyle, { htmlFor: controlId }), {
    type: "element", id: controlId, tag: "select", attrs: { id: controlId, name }, style: formControlStyle,
    children: choices.map((choice) => styled(id, "option", [{ type: "text", text: choice }], undefined, { value: choice }))
  }];
};
const radioGroup = (id: BuilderIdFactory, legend: string, name: string, choices: readonly string[]): ElementNode => styled(id, "fieldset", [
  styled(id, "legend", [{ type: "text", text: legend }]),
  ...choices.flatMap((choice) => { const controlId = id(); return [{ type: "element", id: controlId, tag: "input", attrs: { id: controlId, type: "radio", name, value: choice }, children: [] } as ElementNode,
    styled(id, "label", [{ type: "text", text: choice }], undefined, { htmlFor: controlId })]; })
], { base: { display: "flex", flexWrap: "wrap", gap: 12, padding: 12, borderWidth: 1, borderStyle: "solid", borderColor: "#dedede", borderRadius: 6 } }, { name });
const checkbox = (id: BuilderIdFactory, labelText: string, name: string): PageNode[] => {
  const controlId = id();
  return [{ type: "element", id: controlId, tag: "input", attrs: { id: controlId, type: "checkbox", name, value: "yes" }, children: [] },
    styled(id, "label", [{ type: "text", text: labelText }], undefined, { htmlFor: controlId })];
};
const submitButton = (id: BuilderIdFactory, caption = "送信する"): ElementNode => styled(id, "button", [{ type: "text", text: caption }], {
  base: { width: "fit-content", padding: "10px 20px", borderWidth: 0, borderRadius: 999, backgroundColor: "#0f70eb", color: "#ffffff", fontWeight: 700 }
}, { type: "submit" });
const partForm = (id: BuilderIdFactory, child: PageNode | PageNode[]): ElementNode => formShell(id, "form", Array.isArray(child) ? child : [child]);

/** Basic のフォーム／フォームパーツ。単体パーツも root 配置時に有効な form で包む。 */
export const formInsertionPresets: readonly InsertionPreset[] = [
  { id: "form-1", label: "Form1", group: "フォーム", glyph: "F1", create: ({ id }) => formShell(id, "contact", [
    ...formInput(id, "お名前", "name", "text", "山田 花子", true), ...formInput(id, "メールアドレス", "email", "email", "name@example.com", true),
    ...formTextarea(id, "お問い合わせ内容", "message", "お問い合わせ内容を入力してください"), submitButton(id)
  ]) },
  { id: "form-2", label: "Form2", group: "フォーム", glyph: "F2", create: ({ id }) => formShell(id, "application", [
    ...formSelect(id, "ご希望", "plan", ["選択してください", "プラン A", "プラン B"]), radioGroup(id, "ご連絡方法", "contact", ["メール", "電話"]),
    ...checkbox(id, "内容を確認しました", "confirmed"), submitButton(id, "申し込む")
  ]) },
  { id: "form-3", label: "Form3", group: "フォーム", glyph: "F3", create: ({ id }) => formShell(id, "registration", [
    ...formInput(id, "キーワード", "query", "search", "検索"), ...formInput(id, "パスワード", "password", "password", "パスワード", true),
    ...formInput(id, "添付ファイル", "attachment", "file"), submitButton(id, "確認する")
  ]) },
  { id: "form-input", label: "Input", group: "フォームパーツ", glyph: "I", create: ({ id }) => partForm(id, formInput(id, "項目名", "field", "text", "入力してください")) },
  { id: "form-textarea", label: "Textarea", group: "フォームパーツ", glyph: "TA", create: ({ id }) => partForm(id, formTextarea(id, "項目名", "message", "入力してください")) },
  { id: "form-select", label: "Select", group: "フォームパーツ", glyph: "▾", create: ({ id }) => partForm(id, formSelect(id, "項目名", "choice", ["選択してください", "選択肢 1", "選択肢 2"])) },
  { id: "form-radio", label: "Radio", group: "フォームパーツ", glyph: "◉", create: ({ id }) => partForm(id, radioGroup(id, "項目名", "choice", ["選択肢 1", "選択肢 2"])) },
  { id: "form-confirm", label: "Confirm", group: "フォームパーツ", glyph: "✓", create: ({ id }) => partForm(id, formInput(id, "確認入力", "confirmation", "text", "もう一度入力してください", true)) },
  { id: "form-checkbox", label: "Checkbox", group: "フォームパーツ", glyph: "☑", create: ({ id }) => partForm(id, checkbox(id, "同意する", "agreement")) },
  { id: "form-file", label: "File", group: "フォームパーツ", glyph: "↑", create: ({ id }) => partForm(id, formInput(id, "ファイル", "attachment", "file")) },
  { id: "form-submit", label: "Submit", group: "フォームパーツ", glyph: "→", create: ({ id }) => partForm(id, submitButton(id)) },
  { id: "form-search", label: "Search", group: "フォームパーツ", glyph: "⌕", create: ({ id }) => partForm(id, formInput(id, "検索", "query", "search", "キーワード")) },
  { id: "form-password", label: "Password", group: "フォームパーツ", glyph: "●", create: ({ id }) => partForm(id, formInput(id, "パスワード", "password", "password", "パスワード", true)) }
];

/** 複数ページで再利用しやすい、小さな編集可能部品。 */
export const partInsertionPresets: readonly InsertionPreset[] = [
  { id: "part-button", label: "ボタン", description: "リンク先と文字を編集できるボタン", group: "アクション", category: "parts", glyph: "→", create: ({ id }) => link(id, "詳しく見る", {
    base: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "fit-content", padding: "10px 18px", borderRadius: 999, backgroundColor: "#0f70eb", color: "#ffffff", fontWeight: 700 },
    states: { hover: { backgroundColor: "#0b5cc5" }, focus: { backgroundColor: "#0b5cc5" } }
  }) },
  { id: "part-card", label: "カード", description: "見出し、説明、リンクをまとめたカード", group: "コンテンツ", category: "parts", glyph: "▱", create: ({ id }) => styled(id, "article", [
    element(id, "h3", "カードの見出し"), element(id, "p", "内容を短く紹介する説明文です。"), link(id, "詳しく見る")
  ], { base: { display: "flex", flexDirection: "column", gap: 12, padding: 20, borderWidth: 1, borderStyle: "solid", borderColor: "#dedede", borderRadius: 12 } }) },
  { id: "part-heading-set", label: "見出しセット", description: "補助文、見出し、説明の組み合わせ", group: "コンテンツ", category: "parts", glyph: "H+", create: ({ id }) => styled(id, "div", [
    styled(id, "p", [{ type: "text", text: "SECTION LABEL" }], { base: { fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "#555555" } }),
    styled(id, "h2", [{ type: "text", text: "伝えたいことを見出しに" }], { base: { fontSize: 32, lineHeight: 1.25 } }),
    styled(id, "p", [{ type: "text", text: "見出しを補足する説明文を入力します。" }], { base: { lineHeight: 1.7, color: "#555555" } })
  ], column(8)) },
  { id: "part-list", label: "リスト", description: "編集可能な3項目のリスト", group: "コンテンツ", category: "parts", glyph: "☷", create: ({ id }) => styled(id, "ul", ["リスト項目 1", "リスト項目 2", "リスト項目 3"].map((value) => styled(id, "li", [{ type: "text", text: value }], { base: { padding: "6px 0" } })), { base: { display: "flex", flexDirection: "column", gap: 4, paddingLeft: 24 } }) }
];

const featureCard = (id: BuilderIdFactory, title: string, body: string): ElementNode => styled(id, "article", [element(id, "h3", title), element(id, "p", body)], {
  base: { display: "flex", flexDirection: "column", gap: 8, padding: 20, backgroundColor: "#ffffff", borderWidth: 1, borderStyle: "solid", borderColor: "#dedede", borderRadius: 12 }
});

/** ページの大きな区切りとしてそのまま編集できる標準セクション。 */
export const sectionInsertionPresets: readonly InsertionPreset[] = [
  { id: "section-header", label: "ヘッダー", description: "ロゴ文字とナビゲーションを持つヘッダー", group: "ナビゲーション", category: "sections", glyph: "▔", create: ({ id }) => styled(id, "header", [styled(id, "nav", [
    link(id, "サイト名", { base: { fontSize: 20, fontWeight: 700 } }),
    styled(id, "div", [link(id, "概要"), link(id, "サービス"), link(id, "お問い合わせ")], { base: { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" } })
  ], { base: { display: "flex", flexDirection: "column", gap: 16, width: "100%" }, responsive: [{ minWidth: 768, declarations: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } }] }, { "aria-label": "メインナビゲーション" })], { base: { padding: "20px 24px", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "#dedede" } }) },
  { id: "section-hero", label: "ヒーロー", description: "主見出し、説明、アクションを持つ導入セクション", group: "メイン", category: "sections", glyph: "▰", create: ({ id }) => styled(id, "section", [
    styled(id, "div", [element(id, "p", "WELCOME"), styled(id, "h1", [{ type: "text", text: "暮らしに、新しい選択肢を。" }], { base: { fontSize: 44, lineHeight: 1.15 } }), element(id, "p", "ここにサービスや場所の魅力を伝える文章を入力します。"), link(id, "はじめる")], { base: { display: "flex", flexDirection: "column", gap: 16, flexGrow: 1 } }),
    styled(id, "div", [element(id, "p", "ビジュアル領域")], { base: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: 240, flexGrow: 1, backgroundColor: "#eaf2fd", borderRadius: 16, color: "#555555" } })
  ], { ...responsiveRow, base: { ...responsiveRow.base, padding: "56px 24px", backgroundColor: "#f7f7f7" }, responsive: [{ minWidth: 768, declarations: { flexDirection: "row", alignItems: "center", padding: "88px 48px" } }] }, { "aria-label": "ページ紹介" }) },
  { id: "section-feature-grid", label: "特徴グリッド", description: "見出しと3つの特徴カード", group: "コンテンツ", category: "sections", glyph: "▦", create: ({ id }) => styled(id, "section", [
    styled(id, "div", [element(id, "h2", "選ばれる理由"), element(id, "p", "大切な特徴をわかりやすく紹介します。")], column(8)),
    styled(id, "div", [featureCard(id, "特徴 1", "特徴の説明を入力します。"), featureCard(id, "特徴 2", "特徴の説明を入力します。"), featureCard(id, "特徴 3", "特徴の説明を入力します。")], { base: { display: "grid", gridTemplateColumns: "1fr", gap: 16 }, responsive: [{ minWidth: 768, declarations: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } }] })
  ], { base: { display: "flex", flexDirection: "column", gap: 28, padding: "56px 24px" } }) },
  { id: "section-cta", label: "CTA", description: "行動を促す見出し、説明、ボタン", group: "コンテンツ", category: "sections", glyph: "→", create: ({ id }) => styled(id, "section", [
    styled(id, "div", [element(id, "h2", "次の一歩をはじめましょう"), element(id, "p", "詳しい情報や相談はこちらから。")], column(8)), link(id, "お問い合わせ", { base: { display: "inline-flex", width: "fit-content", padding: "10px 18px", borderRadius: 999, backgroundColor: "#ffffff", color: "#0f70eb", fontWeight: 700 } })
  ], { base: { ...responsiveRow.base, padding: "40px 24px", backgroundColor: "#0f70eb", color: "#ffffff", borderRadius: 16 }, responsive: [{ minWidth: 768, declarations: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: "48px" } }] }) },
  { id: "section-faq", label: "FAQ", description: "編集可能な質問と回答の一覧", group: "コンテンツ", category: "sections", glyph: "?", create: ({ id }) => styled(id, "section", [element(id, "h2", "よくある質問"), styled(id, "div", [
    styled(id, "details", [element(id, "summary", "質問を入力します"), element(id, "p", "回答を入力します。")], { base: { padding: "16px 0", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "#dedede" } }),
    styled(id, "details", [element(id, "summary", "もう一つの質問"), element(id, "p", "回答を入力します。")], { base: { padding: "16px 0", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "#dedede" } })
  ], { base: { display: "flex", flexDirection: "column" } })], { base: { display: "grid", gridTemplateColumns: "1fr", gap: 24, padding: "56px 24px" }, responsive: [{ minWidth: 768, declarations: { gridTemplateColumns: "1fr 2fr", gap: 48 } }] }) },
  { id: "section-footer", label: "フッター", description: "サイト名、リンク、著作権表示を持つフッター", group: "ナビゲーション", category: "sections", glyph: "▁", create: ({ id }) => styled(id, "footer", [
    styled(id, "div", [styled(id, "div", [element(id, "h2", "サイト名"), element(id, "p", "サイトについての短い説明です。")], column(8)), styled(id, "nav", [link(id, "概要"), link(id, "サービス"), link(id, "お問い合わせ")], { base: { display: "flex", flexWrap: "wrap", gap: 16 } }, { "aria-label": "フッターナビゲーション" })], { base: { display: "flex", flexDirection: "column", gap: 24 }, responsive: [{ minWidth: 768, declarations: { flexDirection: "row", justifyContent: "space-between" } }] }),
    element(id, "small", "© サイト名")
  ], { base: { display: "flex", flexDirection: "column", gap: 32, padding: "40px 24px", backgroundColor: "#f2f2f2" } }) }
];
/** hostが明示的に挿入カタログへ加えられる構成例。標準画面には自動追加しない。 */
export const layoutInsertionPresets: readonly InsertionPreset[] = [
  { id: "hstack", label: "横並び", group: "構造", glyph: "↔", create: ({ id }) => stack(id) },
  { id: "grid", label: "グリッド", group: "構造", glyph: "▦", create: ({ id }) => grid(id) },
  { id: "list", label: "リスト", group: "文字", glyph: "☷", create: ({ id }) => list(id) }
];

/** 画面上の標準挿入項目。表示と生成の両方がこの定義だけを参照する。 */
export const standardBuilderDefinition: BuilderDefinition = {
  insertions: [
    { id: "section", label: "セクション", group: "基本", glyph: "▤", create: ({ id }) => element(id, "section") },
    { id: "box", label: "ボックス", group: "基本", glyph: "□", create: ({ id }) => element(id, "div") },
    { id: "img", label: "画像", group: "基本", glyph: "▧", create: ({ id }) => element(id, "img") },
    { id: "text", label: "テキスト", group: "基本", glyph: "T", create: ({ id }) => element(id, "p", "新しいテキスト") },
    { id: "icon", label: "アイコン", group: "基本", glyph: "✓", create: ({ id }) => icon(id) },
    { id: "richtext", label: "リッチテキスト", group: "基本", glyph: "¶", create: ({ id }) => richText(id) },
    { id: "video", label: "動画", group: "基本", glyph: "▶", create: ({ id }) => element(id, "video") },
    { id: "embed-map", label: "Map", description: "Google Maps の共有地図", group: "埋め込み", glyph: "⌖", create: ({ id }) => embed(id, "map", "地図") },
    { id: "embed-youtube", label: "YouTube", description: "YouTube の動画", group: "埋め込み", glyph: "▶", create: ({ id }) => embed(id, "youtube", "YouTube 動画") },
    { id: "embed-vimeo", label: "Vimeo", description: "Vimeo の動画", group: "埋め込み", glyph: "▶", create: ({ id }) => embed(id, "vimeo", "Vimeo 動画") },
    { id: "h2", label: "見出し", group: "文字", glyph: "H", create: ({ id }) => element(id, "h2", "新しいテキスト") },
    { id: "a", label: "リンク", group: "文字", glyph: "↗", create: ({ id }) => element(id, "a", "リンク") },
    { id: "carousel", label: "カルーセル", group: "インタラクション", glyph: "⇆", create: ({ id }) => carouselPreset(id) },
    { id: "toggle", label: "トグル（開閉）", group: "インタラクション", glyph: "▾", create: ({ id }) => togglePreset(id) },
    { id: "video-with-button", label: "VideoWithButton", description: "動画に重なる再生・一時停止ボタン", group: "インタラクション", glyph: "▶", create: ({ id }) => videoWithButtonPreset(id) },
    ...formInsertionPresets,
    ...partInsertionPresets,
    ...sectionInsertionPresets
  ],
  motions: []
};

function validText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** 定義の UI メタデータと ID を検査する。style 値は対象文書の token と合わせて適用時にも検査する。 */
export function defineBuilder(definition: BuilderDefinition): BuilderDefinition {
  const ids = new Set<string>();
  for (const entry of definition.insertions ?? []) {
    if (!identifier.test(entry.id) || ids.has(entry.id) || !validText(entry.label) || entry.description !== undefined && !validText(entry.description) ||
        !validText(entry.group) || entry.category !== undefined && !["basic", "parts", "sections"].includes(entry.category) ||
        entry.glyph !== undefined && (!validText(entry.glyph) || [...entry.glyph].length > 4) || typeof entry.create !== "function") throw new Error("挿入プリセットの定義が正しくありません。");
    ids.add(entry.id);
  }
  ids.clear();
  for (const entry of definition.motions ?? []) {
    if (!identifier.test(entry.id) || ids.has(entry.id) || !validText(entry.label) || entry.description !== undefined && !validText(entry.description)) throw new Error("モーションプリセットの定義が正しくありません。");
    assertMotionStylePatch(entry.style);
    ids.add(entry.id);
  }
  return definition;
}

function merged<T extends { id: string }>(base: readonly T[], custom: readonly T[]): T[] {
  const result = [...base], indexes = new Map(result.map((entry, index) => [entry.id, index] as const));
  for (const entry of custom) {
    const index = indexes.get(entry.id);
    if (index === undefined) { indexes.set(entry.id, result.length); result.push(entry); } else result[index] = entry;
  }
  return result;
}
/** custom は同じ ID の標準項目を置換し、新しい ID は末尾へ追加する。 */
export function resolveBuilderDefinition(custom?: BuilderDefinition): Required<BuilderDefinition> {
  defineBuilder(custom ?? {});
  return {
    insertions: merged(standardBuilderDefinition.insertions ?? [], custom?.insertions ?? []),
    motions: merged(standardBuilderDefinition.motions ?? [], custom?.motions ?? [])
  };
}

function descendants(root: PageNode): PageNode[] {
  const result: PageNode[] = [];
  const visit = (node: PageNode): void => { result.push(node); if (node.type === "element") node.children.forEach(visit); };
  visit(root); return result;
}

/** preset を実体化し、採番・ブロック許可・共通部品制約・文書 validator を通した部分木だけを返す。 */
export function createInsertionNode(preset: InsertionPreset, options: InsertionBuildOptions): PageNode {
  const { document, blocks = {}, components, siteStyles, insertableBlocks, canInsertInstance, idPrefix = "node_" } = options;
  const used = new Set(walkNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [node.id])), issued = new Set<string>();
  let counter = 1;
  const id = (): string => {
    let next = "";
    do next = `${idPrefix}${counter++}`; while (used.has(next));
    used.add(next); issued.add(next); return next;
  };
  const node = preset.create({ id, target: { siteId: document.siteId, pageId: document.pageId, locale: document.locale } });
  // raw treeを先に再帰せず、depth・node数・循環を既存validatorで制限した後のコピーだけを走査する。
  const candidate = parsePageDocument({ ...document, body: [...document.body, node] }, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
  const inserted = candidate.body.at(-1)!, nodes = descendants(inserted);
  for (const entry of nodes) {
    if (entry.type === "text") continue;
    if (!issued.has(entry.id)) throw new Error("挿入プリセットは id factory で全ノード ID を採番してください。");
    if (entry.type === "component" && insertableBlocks !== undefined && !insertableBlocks.includes(entry.block)) throw new Error("このブロックは新しく配置できません。");
    if (entry.type === "instance" && canInsertInstance && !canInsertInstance(entry.component)) throw new Error("このコンポーネントはここへ配置できません。");
  }
  if (insertableBlocks !== undefined && components) {
    const definitions = new Map(components.components.map((component) => [component.id, component] as const)), checked = new Set<string>();
    const inspect = (componentId: string): void => {
      if (checked.has(componentId)) return;
      checked.add(componentId);
      const component = definitions.get(componentId);
      if (!component) throw new Error("このコンポーネントはここへ配置できません。");
      for (const entry of descendants(component.root)) {
        if (entry.type === "component" && !insertableBlocks.includes(entry.block)) throw new Error("追加が許可されていない業務ブロックを含むコンポーネントは配置できません。");
        if (entry.type === "instance") inspect(entry.component);
      }
    };
    for (const entry of nodes) if (entry.type === "instance") inspect(entry.component);
  }
  return structuredClone(inserted);
}

export function motionStylePatch(style: NodeStyle | undefined): MotionStylePatch {
  const base = Object.fromEntries(motionBaseProperties.flatMap((property) => style?.base?.[property] === undefined ? [] : [[property, style.base[property]]])) as MotionStylePatch["base"];
  return {
    ...(base && Object.keys(base).length ? { base } : {}),
    ...(style?.states && Object.keys(style.states).length ? { states: structuredClone(style.states) } : {}),
    ...(style?.appear ? { appear: structuredClone(style.appear) } : {})
  };
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (!plain(left) || !plain(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]));
}
/** presetが宣言したpathだけをsubset照合する。手動の状態色や別の変形が共存してもactiveになる。 */
export function matchesMotionPreset(style: NodeStyle | undefined, preset: MotionPreset): boolean {
  assertMotionStylePatch(preset.style);
  if (preset.style.appear && !equal(style?.appear, preset.style.appear)) return false;
  for (const [property, value] of Object.entries(preset.style.base ?? {})) if (!equal(style?.base?.[property as MotionBaseProperty], value)) return false;
  for (const [state, declarations] of Object.entries(preset.style.states ?? {})) {
    for (const [property, value] of Object.entries(declarations ?? {})) if (!equal(style?.states?.[state as StateName]?.[property as keyof StateDeclarations], value)) return false;
  }
  return true;
}

export function sameMotionValue(left: unknown, right: unknown): boolean { return equal(left, right); }

/** MotionPreset 操作が参照する path 型を builder entry からも利用できるよう公開する。 */
export type MotionTargetPath = NodePath;
