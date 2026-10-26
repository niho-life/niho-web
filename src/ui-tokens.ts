/**
 * Studio と各画面（編集・CMS・翻訳・プロジェクト一覧・ダッシュボード・設定・アナリティクス）が共有する見た目のトークン（#159）。
 * 色・角丸・文字の値はこのファイルだけに置き、各画面の CSS は var(--nw-*) だけを使う。
 *
 * 値は STUDIO 社の実測（Epic #158）に合わせる: 白の背景、薄いグレーの面 2 段、黒に近い本文、補助のグレー、薄い枠、青 1 色、危険の赤。
 * 緑は「公開中」の点（--nw-live）だけ。影は使わず、重なる面は 1px の枠で分ける。角丸は 4 / 6 / 8px、札とアバターは 9999px。
 *
 * ページの文書のトークン（--nw-<名前>）は [data-nw-scope] の要素に閉じて定義されるので、ここで :root に置く値とぶつからない。
 * CSS 変数が届かない所（編集キャンバスの iframe の中・SVG の線・ホストの inline style）は uiColor の値を差し込む。
 */
export const uiColor = {
  /** 画面の背景・パネル */
  bg: "#fff",
  /** 一段沈んだ面（キャンバス・サイドの列・一覧の地） */
  surface: "#f7f7f7",
  /** さらに一段の面（入力欄・札・選択中の行） */
  surface2: "#f2f2f2",
  hover: "#efefef",
  pressed: "#e6e6e6",
  text: "#1a1a1a",
  /** 補助の文字。白の上で 5.9:1、--nw-surface の上で 5.7:1 */
  textSub: "rgba(34,34,34,.7)",
  /** 区切り記号・無効の印など、読まなくてもよい文字（白の上で 3.7:1） */
  textFaint: "#858585",
  border: "rgba(34,34,34,.1)",
  borderStrong: "rgba(34,34,34,.2)",
  /** 選択・リンク・公開などの主な操作。白の上で 4.6:1 */
  accent: "#0f70eb",
  /** 青の操作の hover と、薄い青の上の文字（--nw-accent-soft の上で 5.6:1） */
  accentStrong: "#0b5cc5",
  accentSoft: "#ebf3fe",
  accentBorder: "#b9d1fa",
  /** キャンバスの上で中身を透かす青（挿入位置の面） */
  accentTint: "rgba(15,112,235,.13)",
  onAccent: "#fff",
  /** 作成系の強いボタン（「作成」「＋ 新しい○○」）とトースト */
  inverse: "#222",
  inverseHover: "#3d3d3d",
  onInverse: "#fff",
  onInverseHover: "rgba(255,255,255,.14)",
  danger: "#c62828",
  dangerSoft: "#fdecec",
  onDanger: "#fff",
  warning: "#8a5300",
  warningSoft: "#fff4e0",
  /** 「公開中」の点だけに使う緑 */
  live: "#1f9d45",
  /** 共通部品（コンポーネント）の印 */
  component: "#6d4bc3",
  componentSoft: "#f3f0fa",
  overlay: "rgba(0,0,0,.4)",
  /** 検索結果の見本（Google の配色の写し） */
  serpTitle: "#1a0dab",
  serpText: "#4d5156"
} as const;

/** 入力欄のトークン（docs/editor-ui-design.md「入力欄のトークン」・#71）。値は変えない。 */
export const uiInput = {
  surface: uiColor.surface2,
  border: "#e3e3e3",
  disabled: "#e9e9e9",
  placeholder: "#858585",
  unit: "#666",
  radius: "6px"
} as const;

/** セレクトの右端に描くシェブロン（入力の補助文字と同じ灰色）。CSS の url() にそのまま入れる。 */
export const uiSelectChevron = `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m3 4.5 3 3 3-3' fill='none' stroke='${encodeURIComponent(uiInput.unit)}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

/**
 * トークンの CSS。各画面の CSS の先頭に付き、Studio は studio/build.mjs が assets/studio.css の先頭に足す。
 * :where() で詳細度を 0 にしているので、ホストは :root や部品の根で同じ名前を上書きできる。
 */
export const uiTokensCss = `:where(:root){`
  + `--nw-font:Inter,"Noto Sans JP",-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Segoe UI",Meiryo,sans-serif;`
  + `--nw-font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;--nw-font-size:14px;--nw-font-size-label:12px;--nw-font-size-sub:11px;`
  + `--nw-radius-sm:4px;--nw-radius:6px;--nw-radius-lg:8px;--nw-radius-pill:9999px;`
  + `--nw-bg:${uiColor.bg};--nw-surface:${uiColor.surface};--nw-surface-2:${uiColor.surface2};--nw-hover:${uiColor.hover};--nw-pressed:${uiColor.pressed};`
  + `--nw-text:${uiColor.text};--nw-text-sub:${uiColor.textSub};--nw-text-faint:${uiColor.textFaint};`
  + `--nw-border:${uiColor.border};--nw-border-strong:${uiColor.borderStrong};`
  + `--nw-accent:${uiColor.accent};--nw-accent-strong:${uiColor.accentStrong};--nw-accent-soft:${uiColor.accentSoft};--nw-accent-border:${uiColor.accentBorder};--nw-on-accent:${uiColor.onAccent};--nw-focus:var(--nw-accent);`
  + `--nw-inverse:${uiColor.inverse};--nw-inverse-hover:${uiColor.inverseHover};--nw-on-inverse:${uiColor.onInverse};--nw-on-inverse-hover:${uiColor.onInverseHover};`
  + `--nw-danger:${uiColor.danger};--nw-danger-soft:${uiColor.dangerSoft};--nw-on-danger:${uiColor.onDanger};`
  + `--nw-warning:${uiColor.warning};--nw-warning-soft:${uiColor.warningSoft};--nw-live:${uiColor.live};`
  + `--nw-component:${uiColor.component};--nw-component-soft:${uiColor.componentSoft};--nw-overlay:${uiColor.overlay};`
  + `--nw-serp-title:${uiColor.serpTitle};--nw-serp-text:${uiColor.serpText};`
  // 編集画面の名前（--e-*）。入力欄の値は #71 のまま、ほかは上の --nw-* を指す。
  + `--e-ink:var(--nw-text);--e-muted:var(--nw-text-sub);--e-border:var(--nw-border);--e-border-strong:var(--nw-border-strong);`
  + `--e-ground:var(--nw-surface);--e-hover:var(--nw-hover);--e-blue:var(--nw-accent);--e-blue-soft:var(--nw-accent-soft);--e-part:var(--nw-component);`
  + `--e-input:${uiInput.surface};--e-input-border:${uiInput.border};--e-input-disabled:${uiInput.disabled};--e-placeholder:${uiInput.placeholder};--e-unit:${uiInput.unit};--e-radius:${uiInput.radius};--e-focus:var(--e-blue)`
  + `}\n`;
