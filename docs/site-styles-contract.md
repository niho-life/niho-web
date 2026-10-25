# サイト共通スタイル契約 v1

サイト全体で共有するカラー・長さ・フォント・数値の token と文字スタイル（STUDIO の「スタイル」に相当）を、保存・描画・編集の 3 面で同じ規則で扱う契約です。この文書が正で、[文書・描画契約](document-contract.md#サイト共通スタイル)、[ページ管理・公開情報の契約](page-contract.md#サイト共通スタイルの保存と削除)、[エディター契約](editor-contract.md#サイトとページのスタイル所有権)、[共通部品契約](component-contract.md)、[多言語core契約](localization-contract.md)、[言語別公開契約](localization-release.md) の各節はこの契約の側面ごとの詳細です。

## 責務

| 層 | パッケージが行うこと | ホストが行うこと |
| --- | --- | --- |
| 保存 | `SiteSettings` の `tokens` / `textStyles` の検証、保存要求の形、保存前の全ページ再検証 | 永続化、認可、楽観ロック（CAS）、revision、監査記録、削除時の全ページの原子的な切り離し |
| 描画 | ページ文書とサイト共通の重ね合わせ、同じ実効値による React SSR・静的 HTML・scoped CSS | 同じ公開 snapshot の設定と文書を組で読むこと、キャッシュキーに設定の版を含めること |
| 編集 | 「このページ」「サイト共通」の区別、影響ページの確認、移行、削除の切り離し | ページ一覧・文書・設定の読書き API |

ページ JSON の `schemaVersion` と必須フィールドは変えません。サイト共通スタイルを使わないホストと既存文書の検証・直列化・CSS は変わりません。

## 型

```ts
import type { DesignToken, TextStyle } from "@niho/web/core";

/** サイト設定のスタイル部分。@niho/web/core の SiteStyles。 */
type SiteStyles = {
  tokens?: Record<string, DesignToken>;     // 最大 128 件。名前・型・値の規則はページの tokens と同じ
  textStyles?: Record<string, TextStyle>;   // 最大 64 件。規則はページの textStyles と同じ
};

/** @niho/web/pages の SiteSettings はこれを含む。 */
type SiteSettings = SiteStyles & { title: string; description?: string; ogImage?: PageImage; favicon?: string; locale: string; noindex?: boolean };
```

- `parseSiteSettings`（`@niho/web/pages`）は公開情報とスタイルを一緒に検証し、未知の項目を拒否します。`parseSiteStyles`（`@niho/web/core`）はスタイル部分だけを検証します。
- サイトの文字スタイルは**サイトの token だけ**で検証します。ページの token でサイトの文字スタイルの参照を補うことはできません。
- 値の許可範囲（HEX と限定した色名、長さの単位と上限、フォント名、有限数、文字スタイルのプロパティ）は[文書契約](document-contract.md#トークンと-style)と `src/style-values.ts` の検証が正です。

## 優先順位と重ね合わせ

実効値は token と文字スタイルそれぞれについて `site → page` の順で重ね、**同名の定義はページが丸ごと上書き**します。文字スタイルのプロパティ単位の合成はしません。

```ts
import { parsePageDocument, resolvePageStyles, mergeSiteStyles } from "@niho/web/core";

const page = parsePageDocument(pageJson, blocks, { siteStyles: settings }); // 検証。返る tokens / textStyles はページ所有の定義だけ
const effective = resolvePageStyles(page, settings);                        // 描画・プレビュー用の実効値。保存しない
```

| 状況 | 結果 |
| --- | --- |
| サイトにだけある定義 | ページから参照できる。CSS の `--nw-<name>` に出る |
| ページにだけある定義 | 従来どおりページ所有 |
| 同名 | ページの定義で表示する。サイトの値と同じ値でも、明示されたページの override として保持する |
| ページの override で token の型が変わり、サイトの文字スタイルが不適合になる | 検証で拒否 |
| 共通参照を持つページを `siteStyles` なしで検証 | `unknown token` / `unknown text style` として拒否（旧 renderer・設定を持たないホストで途中までを公開しない） |

共通部品（`instance`）を含むページは、公開時と同じ展開規則で `ページ > サイト共通 > 部品ライブラリ` の順に token を重ねます（[共通部品契約](component-contract.md#展開の規則) の規則 4）。部品ライブラリ自体はサイト共通スタイルを持たず、部品の編集画面ではライブラリの写しにサイトの同名定義だけを重ねます（`resolveComponentStyles`）。

## 描画

```ts
import { generatePageCss } from "@niho/web/core";
import { PageRenderer } from "@niho/web/react";
import { renderPageToHtml } from "@niho/web/server";

<PageRenderer document={pageJson} blocks={blocks} siteStyles={settings} />;
renderPageToHtml(pageJson, blocks, { siteStyles: settings, assets });
generatePageCss(pageJson, blocks, assets, settings);
```

- 3 つの入口は同じ `resolvePageStyles` を使うため、React SSR の初期 HTML に含まれる `<style>` と `generatePageCss` の出力は一致します。HTML の属性（`data-nw-*`）は設定の有無で変わりません。
- `resolvePageDocument(pageJson, library, blocks, settings)` の返す展開済み文書は実効定義を含むため、設定なしで描画できます。公開版にこの形を保存するかはホストが選べます。**下書きの正本には保存しません。**
- 設定を渡さない既存ホスト・旧文書の出力は従来どおりです。`siteStyles: {}` は渡さない場合と同じ出力です。
- 共有設定とページを別の時点から読むと公開中の見た目が変わります。ホストは同じ公開 snapshot の設定・文書を組にして読み、キャッシュキーに設定の版を含めてください。

## 保存契約

保存先は `EditorAdapter` の任意メソッド `readSiteSettings` / `saveSiteSettings` です。公開情報（#23）と同じ 1 つの `SiteSettings` に `tokens` / `textStyles` を持たせ、専用の adapter メソッドは追加しません。既存の adapter を持つホストは変更なしで動き、両メソッドを持たないホストではページのスタイルだけで動作します。

```ts
readSiteSettings(siteId, signal): Promise<{ settings: unknown; version: string }>;
saveSiteSettings({ siteId, settings, expectedVersion, previousStyles? }, signal): Promise<{ status: "saved"; version: string } | { status: "conflict" }>;
siteStyleCapabilities?: { atomicReferenceDetachment: true };
```

- `version` は ETag 等の opaque な楽観ロック値です。`expectedVersion` が一致しない保存は `{ status: "conflict" }`（409）で返し、エディターは入力・元の version・移行前のページを保持して最新の設定と比較できるようにします。自動で上書き・merge・再読込をしません。
- スタイルを変える保存には、保存済み基準の `previousStyles` が付きます。エディターは保存前に全ページを `previousStyles` で検証し、`detachRemovedSiteStyles` の結果を次の設定で再検証し、さらに `readSiteSettings` を読み直して version と内容が基準と同じことを確かめてから送ります。この事前確認は補助で、ホストは `saveSiteSettings` で同じ検証を必ず行います（[保存 API の責務](page-contract.md#サイト共通スタイルの保存と削除)）。
- 使用中の定義の**削除**は、全ページの下書き・公開参照を同じトランザクションで切り離せると宣言したホスト（`siteStyleCapabilities.atomicReferenceDetachment`）だけで許可します。宣言のないホストでは UI と保存前ガードの両方で拒否し、追加・更新だけを使えます。切り離しの純粋関数は `detachRemovedSiteStyles(page, previousStyles, nextStyles)` で、削除 token を参照する宣言を旧 literal 値に、削除文字スタイルはページ所有の定義に置き換えて見た目を保ちます。
- サイト設定の保存は**下書き保存**です。`prepareRelease` の plan には、公開中の設定との before / after を `changes` に、影響する全ページを `affected`（`kind: "site"`）に含めてください。確認 token はサイト設定の version とページ・部品の版に結び付け、`release` で再検証します。
- 監査: ホストは下書き保存・公開・rollback と同じく、サイト設定の保存の実行者と日時を保持し、パッケージとブラウザには表示名だけを返します（[保存・履歴の契約](save-history-contract.md)）。
- 版履歴: `readRevision` は共通スタイルを参照する版について、その版に対応する不変の `siteStyles` snapshot を文書と一緒に返します。履歴表示・差分・復元で現在の設定を過去版へ合成しません。
- プロジェクトの wrapper（`createProjectEditorAdapter`）は元の adapter が実装したメソッドだけを公開し、`previousStyles` と `readRevision.siteStyles` をそのまま通します。

## エディター

スタイルパネルは `readSiteSettings` / `saveSiteSettings` の両方があるホストで「このページ」「サイト共通」を表示し、各行に所有者（このページ / サイト共通）を示します。ページの override を優先した同じ実効値をフィールド・CSS・キャンバスに使います。

- 「サイト共通」で値を確定すると、**全ページの参照と見た目の影響を数えてから**「N ページの参照または見た目に反映されます」と対象ページ、保存済み設定との差分を表示し、確認してから「サイト共通スタイルを保存」できます。影響を検証できない（ページを読めない・部品ライブラリを読めない）場合は保存を許可しません。
- ページの未保存の変更や入力途中の値が残るあいだは「サイト共通」を編集できません。サイトスタイルの編集中はページの編集・下書き保存・ページ移動・公開を止めます。
- 「サイト共通へ移す」はページ定義（文字スタイルが参照するページ token を含む）を移行候補にし、同名衝突の旧値と新値を明示して確認します。サイト保存が成功した時点でページ側の定義削除を編集履歴へ反映し、その後にページ下書きを保存します。サイト保存の失敗・取消でページを参照切れにしません。
- サイト設定の読込に失敗したときは、文書単体で検証できるページだけ編集を始め、共通参照を持つページは理由を示して止めます。

画面の規則の詳細は[エディター契約](editor-contract.md#サイトとページのスタイル所有権)を参照してください。

## 多言語と言語別公開

- token と文字スタイルは翻訳単位ではなく、原文と訳文で共通です。`collectLocalizationUnits` / `materializeLocalizedPage` / `validateLocalizedDocumentSave` には `options.siteStyles` に保存済み設定を渡します。訳文にも継承値は書き戻さず、ページ所有の定義だけを保ちます。エディターは `readSiteSettings` の設定を同じ option に使い、設定の読込が終わるまで訳文の編集を始めません。
- 言語別公開 snapshot は `createPublishedSiteLocaleSnapshot(input, { blocks, siteStyles })` で、各ページを同じ設定で検証したうえで実効値を含む自己完結の文書として固定します。保存済み snapshot の読込・投影・rollback に設定は要らず、後からサイト設定を変えても過去の release は変わりません。サイト共通の変更は次の release の `contentDigest` と差分に現れます。

## 互換性

- `SiteSettings` の `tokens` / `textStyles`、`saveSiteSettings` の `previousStyles`、`siteStyleCapabilities`、`readRevision` の `siteStyles`、`LocalizationExtractionOptions.siteStyles`、`CreateReleaseOptions.siteStyles` はすべて任意の後方互換な追加です。
- 共通参照を持つページは、設定を渡さない旧 renderer・旧 API では検証で止まります。読む側（公開サイト・保存 API・Studio）を先に新しい commit SHA へ更新し、その後にサイト共通スタイルを使い始めてください。
- 旧文書（共通参照なし）の HTML・CSS は設定の有無で変わりません。設定にページと無関係な定義があれば、その token の CSS 変数だけが scope に加わります。

## ホストの実装手順

1. 読む側を更新する: 公開サイトの `renderPageToHtml` / `PageRenderer` / `generatePageCss` と保存 API の `parsePageDocument` に、同じ公開 snapshot の `siteStyles` を渡す。設定を読めない場合は描画・保存を止める（部分表示へ黙って落とさない）。
2. 設定を保存する: `SiteSettings` に `tokens` / `textStyles` を持たせ、`readSiteSettings` / `saveSiteSettings` を実装する。`saveSiteSettings` では認可、`expectedVersion`、`previousStyles` と現在の設定の一致を検証し、全ページ（下書き・公開 snapshot・共有参照）を実効参照で再検証して、新しい opaque な version を返す。実行者と日時を監査記録に残す。
3. 削除を許可する場合: 各ページで `detachRemovedSiteStyles` を適用した結果と新しい設定を同じトランザクションで保存できるときだけ `siteStyleCapabilities: { atomicReferenceDetachment: true }` を宣言する。公開版は同じ見た目の新しい公開 snapshot として作り、過去版を書き換えない。
4. 公開差分に含める: `prepareRelease` でサイト共通の before / after と影響ページを返し、確認 token をサイト設定の version に結び付ける。`readRevision` に版ごとの `siteStyles` snapshot を返す。
5. 多言語・言語別公開を使うホスト: `validateLocalizedDocumentSave` と `createPublishedSiteLocaleSnapshot` に同じ保存済み設定を渡す。
6. 既存ページの token をサイトへ移す: エディターの「サイト共通へ移す」を使うか、同じ順序（サイト設定の保存 → ページ下書きの保存）で移行する。移行後も同名のページ override は残り、サイトの変更から独立する。

## 検証

- `test/site-styles.test.mjs`: 重ね合わせの優先順位、設定なし・空設定での旧文書の互換、SSR と CSS の一致、2 ページへの 1 回の変更の反映、`retainPageStyles` / `detachRemovedSiteStyles`、`parseSiteSettings` の拒否、多言語と言語別公開への接続、`examples/` の例。
- `test/editor-style-ui.test.mjs`: 「サイト共通」の入力・影響の確認・保存、ページの未保存の変更によるロック、2 ページの影響表示、409 競合での入力保持、削除の capability ガード、設定を持たないホストでのページ単位の動作。
- `test/style-model.test.mjs`・`test/components.test.mjs`・`test/component-ui.test.mjs`: 影響判定、共通部品との重ね合わせ、部品の編集での所有者表示。
- `test/editor-layers-session.test.mjs`・`test/project-adapter.test.mjs`: 設定の読込失敗時の文書単体での開始、プロジェクト wrapper の pass-through。

最小の動作例は `npm run demo:site-styles`（`examples/site-styles-demo.mjs`）、画面での確認は `npm run demo` のインメモリ adapter（サイト共通の `brand` と見出し・本文の文字スタイルをホームと「私たちについて」が参照）です。
