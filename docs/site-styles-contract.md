# サイト共通スタイル契約 v1

サイト全体で共有するカラー・長さ・フォント・数値の token と文字スタイル（STUDIO の「スタイル」に相当）を、保存・描画・編集の 3 面で同じ規則で扱う契約です。この文書が正で、[文書・描画契約](document-contract.md#サイト共通スタイル)、[ページ管理・公開情報の契約](page-contract.md#サイト共通スタイルの保存と削除)、[エディター契約](editor-contract.md#サイトとページのスタイル所有権)、[共通部品契約](component-contract.md)、[多言語core契約](localization-contract.md)、[言語別公開契約](localization-release.md) の各節はこの契約の側面ごとの詳細です。

## 責務

| 層 | パッケージが行うこと | ホストが行うこと |
| --- | --- | --- |
| 保存 | `SiteStyles` の検証、版付きread/save/release/migrationのwire契約、描画での重ね合わせ | immutableなdraft/public snapshot、認可、CAS、revision、監査記録、全参照migrationと公開pointerの原子的切替 |
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

## 版と保存

公開情報を含む `SiteSettings` は描画・メタデータ解決用の集約値です。token と文字スタイルの正本・版管理・公開は `site.styles.*` が所有します。既存 `EditorAdapter.readSiteSettings` / `saveSiteSettings` をGUI向けfacadeとして保つhostは、そのstyle部分を共通APIへ委譲します。別のhost-private style保存経路を残しません。公開metadataは従来のhost経路で読み書きできます。rendererにはstyle snapshotとmetadataを組み合わせた `SiteSettings` を渡します。

```ts
type SiteStylesSnapshot = {
  sitePublicationEpoch: string;
  draft: { version: string; styles: SiteStyles };
  published: { stylesVersion: string; styles: SiteStyles };
};

type SiteStylesRevision =
  | { stage: "draft"; version: string }
  | { stage: "published"; version: string };

/** Per-site opaque generation for every committed public pointer change. */
type SitePublicationEpoch = string;
```

`version` と `stylesVersion` は別の不透明な版です。API、adapter、localization関数が個別の版を受け渡すときは、必ず `SiteStylesRevision` のようにstageを明示します。対応hostは初期状態から空の公開snapshotにも `stylesVersion` を割り当て、未対応host（discoveryに操作がない）と、スタイルをまだ追加していないsiteを区別します。draftの `version` は保存ごとに変わり、公開版の `stylesVersion` は公開操作またはmigrationを確定した時だけ変わります。

| 操作 | 入力と結果 | 効果 |
| --- | --- | --- |
| `site.styles.read` | `{ sitePublicationEpoch, draft: { version, styles }, published: { stylesVersion, styles } }` | 編集用draft、現在の公開snapshot、site全体の公開generationを同じsnapshotから読む |
| `site.styles.save` | `{ expectedVersion, styles }` → `{ status: "saved", version }` | draftだけをCAS保存する |
| `site.styles.release-plan` | `{ expectedVersion, expectedStylesVersion, sitePublicationEpoch, operationId }` → `{ plan }` | 公開対象とbefore/afterを固定する |
| `site.styles.release` | 両版、epoch、同じoperation ID、確認token → `{ status: "released", stylesVersion, sitePublicationEpoch }` | 公開中の全ページを新しい共通スタイル版へ切り替える |
| `site.styles.migration-plan` / `site.styles.migration-apply` | delete/renameの変更、両版、epoch、operation ID、確認token | 削除・名前変更と全参照の更新を一括で確定する |

releaseとmigrationの `operationId` はUUID v4です。plan/applyはactor・site・operation ID・入力hashを記録し、同じ入力の再送に同じ結果を返します。確認tokenはplanの全版・対象・依存版と期限に束縛し、一度だけconsumeします。

通常の `site.styles.save` は追加と値の更新だけを受け付けます。draftにあるtokenまたは文字スタイルの定義を省いた入力、または既存名の置換によるrenameは `style_migration_required`（422）で拒否します。ホストは新しいdraft stylesを保存する前に、全draftページ・template・shared document・componentとslot styleなど、共通定義を参照する保存対象を同じ版で再検証します。型変更でページ側overrideや文字スタイルの参照が不正になる場合も保存できません。

### ページの版

`pages.read` / `pages.save` / `pages.apply` はdraft `SiteStyles` で文書を検証します。ホストは各ページrevisionに検証で使ったdraft `version` を記録し、ページの不透明なCAS `version` に文書版とdraft style版の両方を含めます。style対応clientの `pages.read` / `pages.inspect` は `draftStylesVersion` を返し、`pages.apply` は同じ版を任意指定できます。指定があれば完全一致させます。style draftが更新された後に古いページを保存・applyすると409になり、古い画面からの上書きを防ぎます。`PageDocument` wire shapeは変えません。

`pages.release-plan` / `pages.release*` は公開中の `stylesVersion` で検証します。draftだけにあるtokenや文字スタイルを参照するページは、先に共通スタイルを公開するまでページ公開できません。ページ公開のplanとtokenには `stylesVersion` とsite全体の `sitePublicationEpoch` を結び付けます。site.styles対応hostの公開操作はsite-scoped publication fenceを取り、公開pointerの競合を直列化します。単一ページ・localeのrelease/rollbackはcommit直前に両版をCASし、成功時にepochを進めてfenceを解放します。公開中のstylesVersionまたはepochが変わっていれば409 `version_conflict` とし、その古いplanを適用しません。

非同期の `pages.release-set` は同じfence leaseを全項目の完了まで保持します。成功した項目ごとにepochを進め、同じoperation IDの続きだけがそのlease内の最新epochを引き継ぎます。項目ごとの公開結果は従来どおり部分的に見えますが、外部のページ・スタイル・locale公開は409 `site_publication_in_progress` で拒否します。lease失効時は未処理項目を `conflict` に確定し、古いworkerはlease generation CASでcommitできません。全件確定または失効時にfenceを解放します。

### 共通スタイルの公開

公開はdraft保存と独立した二段階操作です。`release-plan` は `expectedVersion`、現在の `expectedStylesVersion`、`sitePublicationEpoch`、operation IDを照合し、before/after、影響する全公開ページ、locale、ページ・部品・presentation等の依存版を返します。planのtokenはactor、site、両スタイル版、epoch、対象一覧、依存版、期限に束縛します。ページ数やlocale数が上限を超える場合、対象を省略せずplanを拒否します。

`release` は計画の版とtokenを再照合し、公開pointerのcommit時にsite-scoped publication fenceを取得します。取得後に `stylesVersion` と `sitePublicationEpoch` を再照合し、公開スタイルpointerと、共通スタイルを実効値へ展開した全公開ページ・全localeのsnapshotを同じCAS境界で原子的に切り替え、epochを進めてfenceを解放します。処理途中の一部ページだけが新しいスタイルになる状態を公開しません。準備済みまたは非同期処理中のページ/locale releaseが先にcommitしていればepochが変わるため、古いstyle planは409 `version_conflict` となり再計画します。fence取得後は他の公開commitを409 `site_publication_in_progress` で拒否し、旧版snapshotを後から公開pointerへ戻しません。

HTML/CSSとページ応答のcache keyにはページrevisionと `stylesVersion` の両方を含めます。host/CDNは公開pointerを解決してからcache lookupし、古いpointerで生成した応答を新しい版のcache keyへ返しません。旧snapshotは不変で残します。

### 削除・名前変更のmigration

token・文字スタイルの削除とrenameは `site.styles.migration-plan` → `site.styles.migration-apply` でのみ行います。`changes` は `{ kind: "delete", styleKind, name }` または `{ kind: "rename", styleKind, from, to }` です。planはdraft `version`、公開 `stylesVersion`、`sitePublicationEpoch`、変更一覧、対象文書・localeと各版、before/after、変更後に保たれる実効値を固定します。rename先の既存名との衝突、未解決参照があればplanを拒否します。見た目が変わる可能性のある提案は明確に区別して確認します。

planだけでは書込みを止めません。apply開始時にhostはsite-scoped migration fenceを取得し、planに含めた全版とepochを再照合します。fence中はpage save/apply/release、site style save/release、翻訳materialize/release、共有文書や部品など共通参照を変える書込みを待たせず、安定エラー `site_style_migration_in_progress`（409）で拒否します。publication fenceとmigration fenceは同時に取得できません。fenceのlease失効やCAS失敗がcommit前に起きた場合はstagingを破棄し、公開pointerに一部を反映しません。

変換結果を公開経路に見せずにstagingし、draft・公開ページ・locale snapshot・共通スタイルpointer・operation記録を一つのCAS境界で確定します。成功時にdraft `version`、公開 `stylesVersion`、`sitePublicationEpoch` をすべて進めます。通常saveでmigration項目を送った場合は安定エラー `style_migration_required`（422）、plan後に版が変わった場合やcommit前にfence leaseが失効した場合は `version_conflict`（409）です。失効時はstagingを破棄して結果を記録し、同じoperation IDの再送にも記録済みの409を返します。新しい試行には新しいplanとoperation IDが必要です。同じactor/site/operation IDと同じ入力の成功済みoperationは保存済みの同じ結果を返し、同じIDを別入力で再利用した場合は `duplicate_operation`（409）です。成功後に通信断した場合も、再送で二重適用しません。

既存の `detachRemovedSiteStyles(page, before, after)` はページ1件を変換する純粋関数として残りますが、全参照列挙・fence・公開snapshot更新・DB transactionを代行しません。migrationを提供しないhostは削除・renameを公開しません。

## エディターとCLI

CLIは共通編集APIの `site.styles.*` 操作を使います。`site.styles.read` はdraft版・公開版と `sitePublicationEpoch` を同じsnapshotから返します。`site.styles.read` がdiscoveryされないhostではCLIはstyle操作を送りません。GUI向けの `EditorAdapter` facadeも同じAPIを呼びます。スタイルUIはdraft版と公開版を別々に表示し、公開はplan→確認→releaseで行います。409では入力を保持し、上書きや自動mergeはしません。

migrationを提供するGUIは影響対象とbefore/after、lossless / semantic / visual-changeの分類をplanで示し、明示確認後だけapplyします。確認できない文書がある場合はapplyを許可しません。

## 多言語と言語別公開

token と文字スタイルは翻訳単位ではありません。`collectLocalizationUnits` / `materializeLocalizedPage` / `validateLocalizedDocumentSave` には原文と訳文で同じ `siteStyles` と `{ stage: "draft", version: draft.version }` を `siteStylesRevision` として渡します。翻訳候補・unit fingerprintはスタイル変更だけでは失効させず、materialize結果と公開準備の依存版にはdraft版を結び付けます。

`createPublishedSiteLocaleSnapshot(input, { blocks, siteStyles, siteStylesRevision })` には `{ stage: "published", version: stylesVersion }` を渡して検証し、実効token / 文字スタイルを含む自己完結したsnapshotを作ります。snapshot JSONのschemaは変えず、ホストは公開 `stylesVersion` をsnapshotのrelease recordに保存します。style releaseでは現行の全locale snapshotを新しい版で作り、公開pointerと一緒に切り替えます。locale release/rollbackのplanにも現在の `stylesVersion` と `sitePublicationEpoch` を固定し、apply直前に一致しなければ409 `version_conflict` にします。非同期処理の最終commitでも再検証し、古いstyle版のsnapshotを後から公開しません。過去snapshotは不変です。page rollbackは現在の公開style版で再検証し、利用できない参照を含む場合は拒否します。

## 互換性とホスト手順

新しいAPI clientは `GET /sites/{siteId}/capabilities?features=site.styles` で拡張操作を要求します。既存clientのqueryなしdiscoveryと、feature queryなしの既存 `pages.*` requestは旧operation一覧・旧response shapeを維持します。対応hostは拡張を要求したclientにだけ `site.styles.*` と `draftStylesVersion` を含む拡張schemaを返し、旧clientへ未知のoperation/schemaを返しません。legacy requestでもhostは現在のstyle snapshotを内部で検証し、opaqueなpage CAS versionと確認tokenへdraft/public style revisionを束縛します。新clientはこのfeature queryを、そのschema拡張がある `pages.*` requestにも引き継ぎます。旧hostがqueryを拒否した場合、新clientはlegacy discoveryへfallbackし、style操作と拡張fieldを送信しません。既存の `PageDocument` は変更せず、hostがpage CAS版にも検証済みdraft style依存を含めます。

既存のqueryなしschemaが持つ `pages.read` / `pages.apply` の `stylesVersion` はdraft版のlegacy aliasとして受け付けます。feature-aware clientは `draftStylesVersion` を使い、`pages.release*` の `stylesVersion` は公開版だけを指します。hostは各endpointのstageを判定して `SiteStylesRevision` へ変換し、旧response shapeへ新fieldを混ぜません。site.styles対応operationのdiscovery error一覧には、該当する `site_publication_in_progress` / `site_style_migration_in_progress` / `style_migration_required` も含めます。

ホスト実装では、style read/save/release/migrationの権限・監査・CASをsite scopeで確認します。style readは `site.settings.read`、draft saveは `site.settings.write` を要求します。site-wide releaseとmigrationのplan/applyはすべて `site.settings.write` とsite全体の `pages.publish` の両方を要求し、ページ単位のgrantだけでsite全体の公開・参照migrationを許可しません。

1. `parseSiteSettings` と `parseSiteStyles` で保存値を検証し、draft/publicの不変snapshotとopaque versionを保存する。
2. draft saveでは削除/renameを拒否し、影響する全draft対象を再検証する。
3. 公開planで全公開locale・ページ・依存版を列挙し、applyで全snapshotのpointerを一度に切り替える。
4. `pages.read/save/apply` はdraft版、page releaseとlocale releaseは公開版で検証する。site-wide public release epochと各planをCASし、ページ/スタイル/localeの非同期publisherが古い公開版を後から確定しないようにする。
5. migrationは全参照を列挙できる時だけ公開し、apply期間のfenceと一括CASを実装する。
6. 翻訳materializeは原文と同じ版を使い、locale release recordにも使用版を保存する。
7. render/cache keyには公開 `stylesVersion` を加える。`SiteSettings` を読むだけでは公開版の版固定の代わりにならない。

## 検証

`test/site-styles.test.mjs` と editing API / CLI の対象テストでは、draft/public version型の分離、公開epochを含むread snapshot、stale CAS、通常saveでのdelete/rename拒否、delete/renameのplan、plan tokenの対象・epoch束縛、ページrelease/locale releaseとの競合、publication fence中の拒否とlease失効、release-setの継続、全ページ/localeの公開切替、途中失敗時に一部style公開が起きないこと、migration fence中の拒否・lease失効・同一operation ID再送、安定エラー、旧discovery/response shapeの互換、翻訳source/targetの版一致を確認します。描画では同じtokenを参照する2ページと複数localeが、公開前は変わらずrelease後に一度に変わることを合成fixtureで確認します。
