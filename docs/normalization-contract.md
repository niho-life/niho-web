# 文書の正規化

`@niho/web/normalize` は React を読み込まず、同一サイトの `PageDocument` と共通スタイルを入力に取ります。通常ページ、翻訳ページ、共有文書、テンプレートを個別の文書として渡せます。入力の文書や設定は変更しません。

```ts
import {
  analyzeNormalization, planNormalization, selectNormalizationOperations,
  decodeNormalizationOperations, verifyNormalization,
} from "@niho/web/normalize";

const input = {
  documents: [{ document, version: pageVersion, presentation }],
  siteStyles,
  siteStylesRevision: { stage: "draft", version: stylesVersion } as const,
  components,
  blocks,
  breakpointSettings,
};

const findings = analyzeNormalization(input);
const plan = planNormalization(input);
const batches = selectNormalizationOperations(plan, { approvedProposalIds: [] });
const operations = decodeNormalizationOperations(batches[0]?.operations ?? []);
// 文書ごとの操作列を既存の EditorOperationById 適用経路に渡す。
const verification = verifyNormalization(input, afterDocuments);
```

文書の版をホストが管理する場合は `documents` の各項目を `{ document, version, componentsVersion?, presentationVersion?, presentation?, locks? }` で渡します。文書の対象は `siteId`、`pageId`、`locale`、`revision` で特定し、計画に受け取った opaque version を保持します。`componentsVersion` を含む文書を検証するときは、同じ版を示す `NormalizationInput.componentsVersion` と対応する `components` snapshot を渡してください。サイト共通スタイルの版は `siteStylesRevision` の stage と version を組にして渡します。`breakpointSettings` は `site.breakpoints.read` が返す `{ settings, version }` です。開始幅の一覧だけを把握している場合は `breakpoints` も使えます。

## 分析と提案

| 提案 | 分類 | 対象 |
| --- | --- | --- |
| カラー token の作成 | `semantic change` | 2 回以上現れる同一リテラルをページ所有の token に置き換えます。通常・幅別・状態・ブロックの slot を集計します。ページ・サイト・部品ライブラリに定義済みの token 名は避け、名前の末尾に連番を付けます。 |
| 文字スタイルの作成 | `lossless` | 同じページで、文字スタイルの対象となる全プロパティと幅別宣言が一致する複数の要素をまとめます。既存の文字スタイル参照を持たない要素が対象です。 |
| 幅別上書きの削除 | `lossless` | 手前の段または適用済み文字スタイルが同じ値を供給する宣言を分析し、検証を通った変更を提案します。token を使う宣言は参照名まで一致する場合を調べます。 |
| 表示幅の段の削除・統合 | `lossy` | 渡された文書や表示コンテキストで使われていない設定段、48px 以内で隣接する段を候補にします。文書内の幅別操作とサイト設定の変更内容をそれぞれ返します。 |
| 要素名 | `semantic change` | 名前がなく、子孫が 8 要素以上あるセクションに、最初の見出しまたはツリー上の位置から候補を出します。提案に保存操作は含めません。 |

文字スタイルのプロパティは文書契約で文字組みに限定されています。ブロックの slot は通常時と幅別の指定を持ち、状態スタイルはブロックの枠に指定します。

色の置換と幅別の削除・統合は別々に承認できます。表示幅の統合は、広い段の宣言を一つ手前の段に移し、同じプロパティでは広い段の指定を優先します。非表示の境界や背景画像を同時に移す必要がある場合、その文書の統合操作は生成しません。サイト設定の変更は `siteSettingsChanges` に入り、設定スナップショットがある場合は適用候補の `settings` と `expectedVersion` を持ちます。必須の PC 段を外す変更は分析結果にだけ表示します。開始幅のみの入力では候補を示し、設定の保存値を省略します。部品マスターやサイト共通文字スタイルの宣言の移動は、それぞれの設定・編集契約を使用します。

## 操作列

`selectNormalizationOperations` は `lossless` と `approvedProposalIds` で明示承認されたページ操作を、対象文書ごとに一つの操作列にまとめます。`includeLossless: false` で承認対象だけに絞れます。各操作列は既存の `pageOperationWire` と同じ JSON 形式です。プロパティ削除を複数まとめる操作では値に `null` が入ります。`decodeNormalizationOperations` はその wire 形式を検証し、`EditorOperationById[]` に戻します。

ホストは操作列を対象の版で照合し、文書ごとに一度の保存・一度の undo として適用します。選択は既存 API の 500 操作上限を使います。段の統合は、同じページの別の変更で移動前後の幅を上書きしないよう、単独で選択します。`siteSettingsChanges` を扱うホストは、対象 ID の明示承認と `site.breakpoints.save` の版照合を行います。

## 描画入力の検証

`verifyNormalization` は、同じ順序・対象（`siteId`、`pageId`、`locale`）の適用前後を同一の表示コンテキストで比較し、`equivalent`、`changed` または `unsupported` を返します。保存後に採番された revision の文書も比較できます。適用時の版照合（CAS）は呼び出し側が行います。部品インスタンスを公開用の文書に展開し、サイトとページのスタイルの優先順位を反映します。presentation を受け取った場合はレイアウト、ヘッダー、フッター、オーバーレイ、登録済み host view の文書も検証します。バージョンとの対応が取れない表示コンテキストや、未解決部品・ブロック・参照がある場合は `unsupported` です。

比較には、要素・業務ブロックの枠・slot に対して renderer が使う宣言、文字スタイル、通常・ホバー・フォーカス・アクティブとその組合せ、幅別非表示を含めます。スタイルが切り替わる各開始幅の直前・境界・直後と、非表示の終了境界を確認します。各要素の入力が自身の境界間で一定なので、他の要素の境界でも同じ結果になります。宣言の優先順、shorthand と個別指定の干渉、token 参照、ブラウザーが以前の宣言を使うフォールバックを保守的に比較します。

検証対象はバージョンを固定した構造化描画入力です。ブロックの中身は同じ props と slot の描画入力を渡す範囲まで確認できます。ホスト独自の CSS・JS・DOM 生成、同時のテーマ変更、画像やフォントの取得結果を比較する API はありません。それらの同等性を含む判定にはホストの描画検証が必要です。`lossy` の提案は幅別のプレビューで確認してから承認します。

## CLI での適用と再開

`analyze` と `plan` はローカルで実行し、JSON を標準出力に返します。入力ファイルは冒頭の `NormalizationInput` と同じ形式です。オンラインで適用する計画には各文書の `version` が必要です。サイトに共通スタイルがある場合は `styles-read` から `draft.styles` と `draft.version` を取得し、`siteStyles` と `siteStylesRevision: { stage: "draft", version }` に入れます。部品・presentation を使う文書には、同じ版の表示コンテキストを添えてください。

```sh
niho-edit normalize analyze --json input.json
niho-edit normalize plan --json input.json > plan.json

niho-edit --origin https://site.example --site sample normalize apply \
  --json plan.json --checkpoint progress.json
niho-edit --origin https://site.example --site sample normalize resume --json progress.json
niho-edit --origin https://site.example --site sample normalize verify --json progress.json
niho-edit --origin https://site.example --site sample normalize undo --json progress.json
```

`apply` は計画を入力から再計算し、ファイル中の計画と一致することを確認します。既定では検証済みの `lossless` 提案を適用します。色の置換や表示幅の変更も適用する場合は、確認した提案の ID を `--approve <提案ID>` で指定します。複数の ID を指定する場合は `--approve` を繰り返します。`site.styles` 対応ホストでは、共通スタイルが空の場合も `styles-read` の下書き値と版を入力へ含めてください。共通スタイルの版が無い計画は拒否します。サイト設定は一つの版照合付き保存にまとめ、同じ開始幅を変更する提案が重複していれば適用を拒否します。Studio の認証経路を使う場合はオンラインのコマンドに同じ `--studio` を付けます。

初回の書き込み前に、計画、変更前の文書、承認 ID とページごとの操作 ID を新しい記録ファイルへ保存します。各操作の送信前と応答の確認後にファイル全体を原子的に更新します。ファイルは所有者だけが読み書きできるモードで作成され、認証ヘッダーや環境変数を含みません。同じ記録ファイルを操作するコマンドは一つずつ実行してください。

`resume` は応答が未確認のページ操作を同じ操作 ID と元の版で再送します。サイト設定の保存応答を受け取れなかった場合は、設定と版を読み直し、適用済みか再送可能かを確認します。`undo` は未確認の操作結果を確定し、適用済みのページと設定を適用直後の版で照合して変更前に戻します。後続の編集があれば競合で止まり、そこまでに確定した進捗が残ります。`verify` は計画に含まれるすべての対象を読み直し、表示コンテキストの版を照合して、描画入力の比較結果を返します。明示承認した意味変更や見た目の変更が現在の文書に含まれると、比較結果は `changed` になり得ます。
