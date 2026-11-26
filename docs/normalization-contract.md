# 文書の正規化

`@niho/web/normalize` は、サイト共通スタイルと複数の `PageDocument` を読み取り、見た目の調整を少ない箇所へまとめる候補と、承認済み変更の `EditorOperationById` plan を作る React 非依存の純粋APIです。保存先・認証・適用順は呼出側が持ちます。

## 入力

`analyzeNormalization(input)` と `planNormalization(input, approvedProposalIds)` は同じ版付きsnapshotを受け取ります。

- `siteId`
- `siteStyles: { version, styles }` — draftのサイト共通tokenと文字スタイル
- `breakpoints: { version, settings }` — 現在のサイト段設定
- `documents: [{ kind, version, document }]` — `page` / `template` / `shared` の保存文書
- `blocks` — 業務ブロックとslot styleの契約（該当文書がある場合）
- `components: { version, library }` — 部品インスタンスを含む文書に必要な版付きライブラリ

全snapshotは契約parserで検証され、site IDの混在・同じpage/localeの重複・版の欠落を拒否します。部品ライブラリを含むplanは `expectedComponentsVersion` も返します。編集・slot・instance style、翻訳localeごとの文書を同じ分析に含めます。

## 提案

`analyzeNormalization` はIDと順序が安定した提案を返します。

| 種類 | 分類 | 検出内容 |
| --- | --- | --- |
| `color-token` | `semantic` | 2箇所以上で使われる同じhex色をサイトtokenへまとめる候補 |
| `text-style` | `semantic` | 全文字style値が一致する2要素以上を共有文字スタイルへまとめる候補 |
| `remove-redundant-override` | `lossless` | 次の上書き・継承値の変化まで確認して、幅別の同値宣言を外す候補 |
| `unused-breakpoint` | `lossless` | 文書・文字スタイルから参照されていない段設定 |
| `merge-breakpoints` | `lossy` | 64px以内の隣接段を統合する候補。視覚差を承認してから適用する |
| `name-section` | `lossless` | 子要素の多い無名 `section` に本文から編集名を付ける候補 |

## 計画

`planNormalization` は `lossless` 提案を含め、`semantic` と `lossy` は `approvedProposalIds` にIDを渡した場合だけ計画へ含めます。未知または重複する承認IDは入力エラーです。

戻り値には、適用前のsite style版・breakpoint版、変更後のsite stylesとsettings、対象ごとのpage版と `EditorOperationById[]` が含まれます。token/text styleの作成は site styles に追加し、ページ側は共通APIの通常保存契約で参照へ切り替えます。near-breakpoint統合は対象段の宣言を外すためlossyとして明示されます。

各ページのplanは共通APIの500操作上限内に収め、上限を超えるページは部分計画にせずエラーにします。plan生成時に、同じ幅のlossy breakpoint統合とsemantic token/text-style変更が重なる場合も拒否します。

このmoduleは計画を作るだけです。実際の保存は利用側が版を再確認し、site style/settingsのCASと1ページ1回の `pages.apply` を使ってください。通信中断後に同じ書込を再送するときは、元のoperation IDと入力を維持してください。lossy候補の適用後は [CUI preview](editing-api-contract.md#cuiでの編集) で幅別の表示差を確認します。

現段階ではanalyze/planの純粋APIまでを提供します。書込みcheckpointによる再開・取消しと、描画入力を使うlossless verifyは後続PRで追加します。承認済み breakpoint 統合と同じ幅のtoken/text-style変更は、適用順による値の消失を避けるためplan生成時に拒否します。
