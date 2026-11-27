# ビルダー接続と第三サイト demo

## BuilderDefinition

Studio の Kamakura エディターは `studio/integration-builder.ts` の同じ定義を `PageEditor` へ渡す。標準挿入はcoreの `standardBuilderDefinition` が正本であり、Studio側へコピーしない。追加パネルは標準の Basic / Parts / Sections を表示し、Parts にはボタン・カード・見出しセット・リスト、Sections にはヘッダー・ヒーロー・特徴グリッド・CTA・FAQ・フッターが含まれる。どれも通常の編集可能な `PageNode` であり、保存・再読込・SSRに専用処理を要求しない。Studio定義は共通の `layoutInsertionPresets` を明示的に追加し、組み立て用の横並び、グリッド、素朴なリストも利用可能にする。

host独自の `InsertionPreset` は任意の `category: "basic" | "parts" | "sections"` で配置先タブを選ぶ。categoryを持たない既存定義は Basic のまま表示されるため変更不要である。`defineBuilder` は未知categoryを拒否し、ID・表示文言・factoryの従来検証も維持する。同じgroupの見出しは各タブ内で保たれる。

業務blockの配置許可はBuilderDefinitionと別である。Kamakura の追加対象は `ManagedEmbed` に限定する。保存済み業務blockの安全な表示と、自由な新規配置を区別する。

## Atelier Moku demo

`atelier` はKamakuraとExperienceの名称・業務データを含まない第三サイトである。次を1つの操作可能な例に含む。

- 標準項目と横並び・グリッド・リスト
- 独自の「作品カード」挿入
- 条件styleと登場を組み合わせる独自motion宣言
- 検証済み `WorkshopNote` block
- `atelier_signature` 共通部品instance
- ローカルSVG画像
- expectedVersionによる下書き・共通部品のCAS保存
- 対象、文書、block、共通部品、公開確認tokenのserver側検証
- 部品展開後のSSRとscoped CSS

起動する。

```sh
npm run demo:builder
```

既定は `127.0.0.1:4177` だけでlistenする。`PORT` が設定済みの場合はそのportを使う。下書きと共通部品はserver processのメモリに保存するため、ブラウザを再読込しても残り、serverを再起動すると初期化される。`/preview` は現在の下書きを共通部品展開後にSSRする。

## 任意機能と境界

BuilderDefinition、共通部品、業務block、素材、motionは独立した任意機能である。接続しない機能は利用可能に見せない。制作定義が返す部分木、編集操作後の文書、保存要求、SSR入力は既存validatorを通す。保存文書は `schemaVersion: 1` のままで、関数、任意HTML、任意CSS、backend URL、秘密を含めない。

Editor componentとWorkerの接続先はソースコードで固定する。公開文書やURLがReact component、service binding、upstream origin、署名keyを選ぶことはできない。新しいhost固有のrouteや権限差はhost adapterへ閉じ、core/editorにsite名の条件を追加しない。

## 対象受入

2026-10-22の対象testでは、第三サイトの挿入、階層移動、Grid配置、条件styleとmotion、undo/redo、CAS保存、再読込、公開plan/token、SSR/CSSを連続して確認した。

```sh
npm run build
node --test test/atelier-builder-demo.test.mjs
npm run studio:typecheck
npm run studio:build
```

## 実ブラウザ受入（2026-10-22）

第三サイトdemoを最終workspaceで操作し、次を確認した。

- テキスト編集、undo/redo、保存、ブラウザ再読込後の保持。
- 独自の作品カード挿入と `atelier_main` 配下への移動。選択IDと実DOMの親を照合。
- 画像専用タブのURL・レスポンシブURL・説明欄と、対象別のタブ構成。
- 375px幅・50%表示でiframeのCSS幅375px、画面上の幅約188px。文書幅と倍率を分離。
- 条件付き変形Y=-6pxを直接入力し、キャンバスのcomputed styleと保存を確認。
- 2タブのCAS競合で編集内容を保持。比較画面を閉じた後も「比較する」が表示され、最新内容へ復旧可能。
- 左パネルを閉じてもツール列が残り、左右パネルとも復帰可能。390×844pxでも操作可能。

Studioの公開アプリは確認時にメンテナンス画面だったため、公式ヘルプのエディタ全体・インスペクターの画像を視覚基準にした。指定された既存Kamakura管理画面とそのCSSも参照した。今回のブラウザ操作先はローカルの合成データdemoであり、本番2サイトのデータや公開状態は変更していない。
