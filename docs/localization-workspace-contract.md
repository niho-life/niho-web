# 翻訳の画面（LocalizationWorkspace）と adapter の契約

`LocalizationWorkspace` は、サイトの翻訳の残りを確認し、言語ごとまとめて公開する画面です。CMS の同じ項目で訳文を直すときは `LocalizationItemWorkspace` を `CollectionWorkspace.itemLanguages.renderTarget` に置きます。両方とも同じ adapter と項目エディタを使い、訳文・確認状態の正本を分けません。React 不要の型・runtime parser・印（置き換えてはいけない部分）の扱いは `@niho/web/localization-workspace-model` にあります。

この段（W1）は画面と、ホスト（サイト）が実装する adapter の契約だけです。Studio の BFF・サイトごとの adapter・切替のフラグ・描画用の枠（サイト側の静的なページ）は含みません。

## 正本と責務

原文・訳文・確認の記録・公開の正本はサイトにあります。ライブラリは表示・入力・その場の確かめ・自動保存のタイミング・古い応答の破棄・プレビューの枠への受け渡しだけを持ち、次のことはサイト（と BFF）の責務です。

- **認証と認可。** 各呼び出しで、今の利用者がその操作をしてよいかを確かめます。画面から渡る `itemKey`・`unitId`・版・token は認可の証明ではありません。権限が無いときは `{ status: "forbidden" }` を返します。画面は表示していた中身を消し、権限が無いと出します。
- **できる操作の一覧（`permissions`）を返すこと。** 画面はこの一覧で操作を出し分けるだけです。サーバーは同じ判断を書き込みの API でも必ず行ってください（画面の出し分けは防御ではありません）。
- **保存と CAS。** 書き込みは「項目の版」と「原文の版」を比べ、どちらかが違えば上書きせず `conflict` に最新を付けて返します。`operationId` が同じ再送は、二重に書かず前回と同じ結果を返します。
- **原文の取り込み・状態の計算・人が読む名前・まとまり・公開できない理由。** 画面は内部の識別子（保存先の key、内部の項目の key、generation など）を表示しません。表示に使うのは `label`・`title`・`message` などサイトが作った人が読む文字だけです。
- **翻訳サービスの呼び出し。** 画面は翻訳サービスを呼びません。`requestTranslation` で依頼し、結果は「翻訳案（candidate）」として項目に載ります。
- **公開。** 準備・確認の token の発行と一回限りの消費・期限・反映・履歴・戻しはサイトが持ちます。
- **画像の置き場と変換、プレビューの描画。** プレビューの中身はサイトが用意する描画用の枠（下の「プレビューの枠」）が描きます。

例外（throw・reject）は画面では一般的な失敗（「保存できませんでした」と再試行）になります。秘密や内部の詳細をエラーの文に含めないでください。

## 使い方

```tsx
import { LocalizationWorkspace, type LocalizationWorkspaceAdapter } from '@niho/web/localization-workspace';

const adapter: LocalizationWorkspaceAdapter = {
  loadOverview: (signal) => host.post('/localization/overview', {}, signal),
  listItems: ({ cursor }, signal) => host.post(cursor ? `/localization/items/after/${cursor}` : '/localization/items', {}, signal),
  loadItem: ({ itemKey }, signal) => host.post(`/localization/items/${itemKey}`, {}, signal),
  command: (input, signal) => host.post(`/localization/items/${input.itemKey}/command`, input, signal),
  requestTranslation: (input, signal) => host.post(`/localization/items/${input.itemKey}/translate`, input, signal),
  readJob: ({ jobId }, signal) => host.post(`/localization/jobs/${jobId}`, {}, signal),
  advanceCatalog: (input, signal) => host.post('/localization/catalog/advance', input, signal),
  loadPreview: (input, signal) => host.post('/localization/preview/items', input, signal),
  readRelease: (signal) => host.post('/localization/release', {}, signal),
  prepareRelease: (input, signal) => host.post('/localization/release/prepare', input, signal),
  applyRelease: (input, signal) => host.post('/localization/release/apply', input, signal),
  saveSettings: (input, signal) => host.put('/localization/settings', input, signal),
  // 任意: uploadImage, pickAsset, sourceLink
};

<LocalizationWorkspace adapter={adapter} initialItemKey={route.itemKey} onNavigate={(state) => router.replace(state)} />;
```

| props | 内容 |
| --- | --- |
| `adapter` | 下の契約。参照を替えると画面の状態を作り直し、進行中の読み書きを abort します。 |
| `initialItemKey` | 最初に開く 1 件。無い・見つからないときは一覧。最初の表示だけに使います。 |
| `initialView` | `"list"`（既定）か `"settings"`。 |
| `onNavigate` | 一覧・1 件・設定を移ったときに `{ view: "list" \| "item" \| "settings", itemKey: string \| null }` で呼びます。最初の表示では呼びません。 |
| `timeZone` | 日時の表示のタイムゾーン。既定は `Asia/Tokyo`。 |
| `autosaveDelay` | 直してから自動で保存するまでの待ち時間（ms）。既定は 1000。 |
| `pollInterval` | 翻訳の依頼・原文の取り込み・公開の進み具合を読み直す間隔（ms）。既定は 2000。 |

`LocalizationItemWorkspace` には同じ `adapter`、対象の `itemKey`、原文のタブへ戻る `onBack` を渡します。原文の取り込みが進行中なら先に `advanceCatalog` を進め、完了後に対象の 1 件を読みます。一覧全体や公開画面は読みません。`timeZone`・`autosaveDelay`・`pollInterval` も共通です。CMS の言語タブから安全に戻るため、`registerBack` に項目エディタの保存処理を登録します。原文の入力は切替中も残り、訳文は保存してから閉じるので、次に開くと最新の原文を読みます。

部品は `<style>` で `localizationWorkspaceCss` を入れます（CMS の画面の `collectionCss` を含みます）。inline の `<style>` を CSP で拒むホストは、この文字列をファイルにして読み込んでください。根の class は `.nw-collection.nw-localization`、翻訳の画面だけのクラスの接頭辞は `lw-` です。色・角丸・文字は CMS の画面と同じ `@niho/web/ui-tokens` のトークン（`--nw-*`）を使います。

## 識別子と大きさの上限

parser は未知の key を拒み、次の形と上限を確かめます。上限を超えた応答は例外（`DocumentValidationError`）で、画面では失敗として扱います。

| もの | 形 | 上限 |
| --- | --- | --- |
| `itemKey` | `^[A-Za-z0-9_-]+$`（ID を base64url にしたものを推奨。path にそのまま入れられる） | 200 文字 |
| `unitId` | `^[A-Za-z][A-Za-z0-9_.-]*$` | 300 文字 |
| まとまりの `id`・印の `id` | `^[A-Za-z0-9_-]+$` | 80 文字・印は 32 文字 |
| `operationId` | 画面が作る `^[A-Za-z0-9_-]{16,64}$` | — |
| `cursor`・`jobId` | `^[A-Za-z0-9_-]+$` | 512 文字・128 文字 |
| `releaseId` | `^[A-Za-z][A-Za-z0-9_-]*$` | 128 文字 |
| `confirmationToken`・`resumeToken` | `^[A-Za-z0-9._~+/=-]+$` | 512 文字 |
| 版（`version`・`sourceVersion`・`expectedVersion`） | 制御文字を含まない 1 行の不透明な文字列 | 200 文字 |
| 名前（`label`・`title`） | 1 行 | 200 文字・題名は 1000 文字 |
| `message`（公開できない理由など） | 1 行 | 400 文字 |
| 一覧の 1 回の応答 | — | 500 件（画面は `nextCursor` を最大 100 回たどる） |
| 1 件の項目 | — | 2000 項目 |
| 文字の値 | — | 100,000 文字・印 200 個 |
| リッチテキスト | niho-web の `LocalizedRichText`（下） | 本文 100,000 文字・入れ子 48 段 |
| まとまり・公開できない理由・履歴・プレビューの候補 | — | 50・200・1000・50 |
| プレビューの材料 | JSON | 1 回の応答 2 MiB・1 回の表示で 40 回・合計 16 MiB |
| 日時 | タイムゾーン付きの ISO 8601 | 40 文字 |

画面からの入力（`command` の値など）も同じ上限を超えないようにしてから送ります。サイトも同じ上限で確かめてください。

## adapter

すべて `(input, signal: AbortSignal) => Promise<unknown>`（`loadOverview`・`readRelease` は `(signal)`）で、戻り値は runtime parser（`parseLocalization…Result`）で確かめます。どの応答でも `{ status: "forbidden" }` を返せます。1 件・1 項目・依頼を指す応答は `{ status: "not_found" }` も返せます。

| メソッド | 入力 | 応答 |
| --- | --- | --- |
| `loadOverview` | — | `{ status: "ready", overview }` |
| `listItems` | `{ cursor: string \| null }` | `{ status: "ready", items: ItemSummary[], nextCursor: string \| null }` |
| `loadItem` | `{ itemKey }` | `{ status: "ready", item }` / not_found |
| `command` | `{ itemKey, operationId, action, unitId, expectedVersion, expectedSourceVersion, … }`（下） | `{ status: "applied", unit, summary }` / `{ status: "conflict", unit, summary }` / `{ status: "invalid", message }` / not_found |
| `requestTranslation` | `{ itemKey, operationId, unitIds: string[] \| null }` | `{ status: "queued", job }` / invalid / not_found |
| `readJob` | `{ jobId }` | `{ status: "ready", job }` / not_found |
| `advanceCatalog` | `{}` | `{ status: "updating", progress }` / `{ status: "current" }` |
| `loadPreview` | `{ itemKey, previewId, cursor: string \| null }` | `{ status: "ready", material, nextCursor: string \| null }` / not_found |
| `readRelease` | — | `{ status: "ready", current, history, pending }` |
| `prepareRelease` | `{ operation, releaseId, expectedVersion, expectedCurrentVersion, resumeToken }` | `{ status: "preparing", progress, resumeToken }` / `{ status: "ready", plan }` / `{ status: "blocked", blockers }` / `{ status: "conflict" }` |
| `applyRelease` | `{ confirmationToken, resumeToken }`（どちらか 1 つだけ文字列） | `{ status: "applying", progress, resumeToken }` / `{ status: "applied", current }` / `{ status: "expired" }` / `{ status: "conflict" }` |
| `saveSettings` | `{ expectedVersion, autoDraft }` | `{ status: "saved", settings }` / `{ status: "conflict", settings }` / invalid |
| `uploadImage`（任意） | `{ itemKey, unitId, file }` | `{ status: "uploaded", image }` / `{ status: "rejected", reason: "type" \| "size" \| "permission" \| "invalid" }` |
| `pickAsset`（任意） | `{ itemKey, unitId }` | `{ status: "picked", image }` / `{ status: "cancelled" }`（素材の選び方の画面はホストが出す） |
| `sourceLink?(itemKey)` | —（同期） | 原文を CMS で開く URL（https、または `/` から始まる同じサイトの path）か `null` |
| `editLink?(itemKey)` | —（同期） | サブの言語を直すホスト画面の URL。ページはエディタ、CMS 項目は項目のサブ言語タブ。安全な URL があれば行はその画面へ移り、無ければ従来の翻訳項目画面を開く。Kamakura の `common:<pageId>` は `?page=<pageId>&lang=en` で English キャンバスへ、CMS は `?lang=en` で同じ項目の English タブへ移る。その他の項目はこの画面で編集する |

- 応答の `summary.key`・`item.key`・`unit.unitId` は要求と一致必須です（違えば例外）。
- 読み取りも POST で送れるよう、入力はすべて JSON の本文に収まる形です。query string は使いません。

### 概要（overview）

```ts
type LocalizationOverview = {
  version: string;                         // 翻訳全体の版。公開の準備の CAS に使う
  sourceLocale: 'ja' | 'en'; targetLocale: 'ja' | 'en';   // サイトの設定（SiteLocalizationConfig）から。違う言語であること
  languages: { source: string; target: string };          // 人が読む言語名（例 "日本語" / "English"）
  permissions: LocalizationPermission[];   // できる操作の一覧（重複なし）
  groups: { id: string; label: string; items: number; needsWork: number; reviewed: number; excluded: number }[];
  release: { current: LocaleReleaseSummary | null; pending: LocaleReleasePending | null };
  blockers: LocaleReleaseBlocker[];        // 今の状態で公開できない理由（無ければ空）
  catalog: { state: 'current' } | { state: 'updating'; progress: { done: number; total: number } };
  preview: { frameUrl: string } | null;    // 描画用の枠。null ならプレビューを出さない
  settings: LocalizationSettings;
};
type LocalizationPermission = 'edit' | 'review' | 'translate' | 'publish' | 'rollback' | 'settings';
type LocalizationSettings = {
  version: string;
  autoDraft: boolean;                      // 原文の変更箇所を自動翻訳するか。人が直した・確認した訳は候補に留める
  translator: { connected: boolean };      // 翻訳サービスにつながっているか（設定の中身は出さない）
  queue: { waiting: number; failed: number; nextRetryAt: string | null };
};
```

| 権限 | 画面で出すもの |
| --- | --- |
| `edit` | 訳文の入力・画像の操作・原文の取り込みを自動で進めること。無ければ入力は読むだけ |
| `review` | 項目ごとの「確認済みにする」 |
| `translate` | 「翻訳案を作る」 |
| `publish` | 「{訳す言語}版を公開…」と、途中の公開の「続ける」 |
| `rollback` | 公開の履歴からの「この版に戻す…」 |
| `settings` | 設定の変更（無ければ設定は読むだけ） |

推奨の割り当て（オーナー判断の 1）: `publish`・`rollback`・`settings` は owner だけ。editor は `edit`・`review`・`translate` まで。

`groups` は左に出すまとまり（例: 固定ページ・共通部分・記事）です。件数はサイトが数えます（一覧を全部読み終える前から出すため）。`needsWork` は要対応（下の状態の `untranslated`・`draft`・`source-changed`）の件数です。

`catalog` が `updating` のあいだ、`edit` の権限がある画面は `advanceCatalog` を `pollInterval` ごとに呼び、帯に「原文を取り込んでいます n/m」と出します。`current` が返ったら概要と一覧を読み直します。人が押すボタンにはしません。取り込みの途中でも、前の版の原文で一覧・項目を読め、直せるようにしてください（差分の取り込み）。

### 一覧（ItemSummary）

```ts
type LocalizationItemSummary = {
  key: string;                    // itemKey
  groupId: string;                // overview.groups のどれか（無ければ「すべて」にだけ出す）
  title: string;                  // 原文の題名（空なら「無題」と出す）
  path: string | null;            // 原文のアドレス。"/" から始まる
  includedParts?: string[];       // 同じ行へまとめた内容（人が読む短い名前。最大 8 件）
  state: 'untranslated' | 'draft' | 'source-changed' | 'reviewed' | 'excluded';
  excludedReason: string | null;  // state が excluded のときだけ・必須（例「英語版を作らない設定です」）
  totalUnits: number; reviewedUnits: number;    // 確認済み n/m（reviewedUnits <= totalUnits）
  imagesUnreviewed: number;       // 差し替えたのにまだ確認していない画像の数
  sourceDraftPending: boolean;    // 原文の CMS に未公開の下書きがある
  updatedAt: string | null; updatedBy: string | null;
};
```

| state | 意味 | 印 | 絞り込み |
| --- | --- | --- | --- |
| `untranslated` | 訳文がまだ無い項目がある | 未翻訳（中抜きの丸） | 要対応 |
| `draft` | 訳文はあるが、確認していない項目がある | 未確認（半分の丸） | 要対応 |
| `source-changed` | 確認した後に原文が変わった項目がある | 原文が更新（三角） | 要対応 |
| `reviewed` | すべて確認済み | 確認済み（✓） | 確認済み |
| `excluded` | 訳さない（理由つき） | 対象外（斜線の四角） | 対象外 |

複数が当てはまるときは表の上の方を優先してください（例: 未翻訳と原文の更新が両方ある → `untranslated`）。

`listItems` は段階で返します。最初は `cursor: null`、続きは前の応答の `nextCursor` で呼び、`null` で終わりです。画面は届いた分から出し、続きを読んでいるあいだは「残りを読み込んでいます」と出します。1 件の項目が多く、サイトの内部で分けて持っているもの（ページの分割など）は、1 件にまとめて返してください。

### 1 件（Item）と項目（Unit）

```ts
type LocalizationItem = LocalizationItemSummary & {
  units: LocalizationWorkspaceUnit[];   // 並び順どおりに出す
  previews: { id: string; label: string }[];   // プレビューで表示できるページ（例「トップ」）。空ならプレビューを出さない
  job: LocalizationJob | null;          // この 1 件の翻訳の依頼で、まだ終わっていないもの
};
type LocalizationWorkspaceUnit = {
  unitId: string;
  label: string;                  // 人が読む名前（例「題名」「本文の 2 段落目」「カバー画像」）
  section: string | null;         // 項目の小見出し（例「見出し」「フッター」）。同じ値が続く項目をまとめて出す
  required: boolean;
  version: string;                // 項目の版（CAS）
  sourceVersion: string;          // 原文の版（CAS）。原文が変われば変わる
  state: 'source' | 'missing' | 'draft' | 'review-needed' | 'reviewed';
  updatedAt: string | null; updatedBy: string | null;
} & (
  | { kind: 'text'; source: string; value: string | null; previousSource: string | null;
      editOrigin?: 'AUTO' | 'MANUAL' | null; // 保存済み訳文の出どころ。古い adapter は省略可
      candidate: { candidateId: string; value: string } | null;
      marks: { id: string; label: string }[]; maxLength: number | null; singleLine: boolean }
  | { kind: 'rich-text'; source: LocalizedRichText; value: LocalizedRichText | null; previousSource: LocalizedRichText | null;
      editOrigin?: 'AUTO' | 'MANUAL' | null;
      candidate: { candidateId: string; value: LocalizedRichText } | null }
  | { kind: 'image'; source: LocalizationImage; value: LocalizationImage | null }
);
type LocalizationImage = { asset: LocalizedAsset; url: string };   // asset は niho-web の LocalizedAsset。url は表示用（https か "/" から始まる path）
```

| unit の state | 意味 | value |
| --- | --- | --- |
| `source` | 訳さず原文のまま使う（`required: false` の画像など） | `null` |
| `missing` | 訳文がまだ無い | `null` |
| `draft` | 訳文はあるが確認していない | あり |
| `review-needed` | 確認した後に原文が変わった（画面では「原文が更新」）。`previousSource` に確認したときの原文を入れられる | あり |
| `reviewed` | 今の原文に対して確認済み | あり |

- `previousSource` は `review-needed` のときだけ値を持てます。
- `editOrigin` は訳文を自動翻訳で保存したら `AUTO`、人が編集して保存したら `MANUAL` です。`draft` の項目に限り、画面はそれぞれ「自動翻訳（未確認）」「手修正（未確認）」と表示します。省略または `null` は「未確認」です。画像には付けません。
- `candidate` は翻訳サービスが作った案です。画面は「翻訳案を使う」で `adopt-candidate` を送ります。
- 画像の `value: null` は「原文と同じ画像を使う」です。

#### 文字の印（置き換えてはいけない部分）

文字（`kind: "text"`）の値は 1 つの文字列です。URL・数字・固有の記号など、訳しても変えてはいけない部分は、文字列の中に `⟦id⟧`（U+27E6・U+27E7 で囲んだ印の `id`）で入れ、`marks` に人が読む名前（例「リンク先」「価格」）を付けます。

- 原文（`source`）の印は `marks` と一対一で、各 `id` がちょうど 1 回ずつ出ます（parser が確かめます）。
- 画面は `⟦id⟧` を表示せず、`label` の小さな札として出します。札は消せず、文字だけを直せます。札の位置は切り取り・貼り付けで動かせます。
- 訳文の札の数が原文と合わない（足りない・多い・知らない印）ときは保存しません（「札が足りません：リンク先」）。サイトも同じことを確かめ、合わなければ `invalid` を返してください。
- `maxLength` は印を除いた文字の数（コードポイント）です。`singleLine` なら改行を入れられません。
- 保存済みの訳文（`value`・`candidate.value`）は札の数が合わなくても読めます（画面が知らせて直させます）。ただし `marks` に無い `id` の印を含む値は拒みます。

#### リッチテキスト

リッチテキスト（`kind: "rich-text"`）の値は niho-web の `LocalizedRichText`（`@niho/web/localization`）です。

```ts
type LocalizedRichText = { kind: 'rich-text'; children: LocalizedRichTextNode[] };
type LocalizedRichTextNode =
  | { type: 'text'; text: string }
  | { type: 'element'; id: string; tag: 'a' | 'strong' | 'em' | 'b' | 'i' | 'small' | 'span' | 'br'; children: LocalizedRichTextNode[] };
```

- 要素（リンク・太字など）の `id` と `tag` と入れ子の親子は原文と同じでなければいけません。文字と、要素の前後の文字の並びは変えてかまいません（例「詳しくは〔リンク〕こちら〔/リンク〕」→「〔リンク〕Click here〔/リンク〕 for details」）。
- 画面は要素の始まりと終わりを対の札（`br` は 1 つの札）で出し、札の数・対・入れ子が原文と合わないときは保存しません。サイトも保存の前に同じことを確かめてください（`localization.ts` の検証と同じ規則）。
- リンクの href・装飾の class などの属性は値に含めません。原文の要素のものをサイトが使います。

### 書き込み（command）

```ts
type LocalizationCommandInput = {
  itemKey: string; operationId: string; unitId: string;
  expectedVersion: string;        // 画面が直し始めたときの項目の版
  expectedSourceVersion: string;  // 画面が見ていた原文の版
} & (
  | { action: 'set-value'; value: string | LocalizedRichText }     // 文字・リッチテキスト
  | { action: 'adopt-candidate'; candidateId: string }               // 翻訳案を使う
  | { action: 'review-current' }                                     // 今の訳文を確認済みにする（文字・リッチテキスト）
  | { action: 'clear-value' }                                        // 訳文を消して未翻訳に戻す（文字・リッチテキスト）。翻訳案は残す
  | { action: 'set-image'; image: LocalizedAsset | null }            // 画像を差し替える。null は原文と同じに戻す
  | { action: 'review-image' }                                       // 差し替えた画像を確認済みにする
);
```

- **CAS。** `expectedVersion` が今の項目の版と違う、または `expectedSourceVersion` が今の原文の版と違うときは、書かずに `{ status: "conflict", unit, summary }`（`unit` は最新）を返します。版は項目ごとに比べるので、同じ 1 件の別の項目を別の人が直していても衝突しません。
- **冪等。** `operationId` は画面が操作ごとに作ります。同じ `operationId` の再送（通信が切れたときの再試行など）は二重に書かず、前回と同じ結果を返してください。保存しておく期間は 24 時間以上を推奨します。
- **応答。** `applied` の `unit` は書いた後の項目、`summary` はその 1 件の一覧の行（状態・件数の更新に使う）です。`set-value` で訳文を直すと、確認済みだった項目は `draft` に戻します。
- **訳を消す。** `clear-value` は訳文（下書き・確認済み）を消し、項目を未翻訳（必須なら `missing`・任意なら `source`）に戻します。翻訳案は残します。訳文の無い項目と画像は `invalid` です（画像は `set-image` に `null` で原文に戻します）。
- **invalid。** 札が合わない・長すぎる・空にできない項目を空にした・画像が使えない、などは `{ status: "invalid", message }` で、`message` を項目の下に出します。
- 項目が原文から消えたときは `not_found` です。画面は「この項目は原文から無くなりました」と出し、読み直しを勧めます。
- 権限の確かめ: `set-value`・`adopt-candidate`・`clear-value`・`set-image` は `edit`、`review-current`・`review-image` は `review` です。

### 翻訳の依頼（requestTranslation・readJob）

```ts
type LocalizationJob = { jobId: string; state: 'queued' | 'running' | 'done' | 'failed'; message: string | null };
```

`unitIds: null` はその 1 件の訳文の無い項目すべてです。画面は `queued`・`running` のあいだ `readJob` を `pollInterval` ごとに（最大 150 回）読み、`done` で 1 件を読み直します（翻訳案が `candidate` に載る）。`failed` の `message` は人が読む文で出します（翻訳サービスの設定などの内部の詳細を入れないこと）。

### プレビュー（loadPreview）

`loadPreview` はプレビューの材料（`material`）を返します。材料の中身はサイトと描画用の枠だけが知る JSON で、画面は解釈せず、そのまま枠へ渡します。大きいときは `nextCursor` で分けて返してください（画面は全部を集めてから渡します）。材料には、その利用者が読んでよいものだけを入れ、秘密（token・内部の key・非公開の設定）を入れないでください。

### 公開と戻し（readRelease・prepareRelease・applyRelease）

言語全体の公開の型は `src/locale-release-contract.ts` にあります（ページ編集の `EditorLocaleRelease*` もここから再 export しています）。

```ts
type LocaleReleaseSummary = { releaseId: string; version: string; label: string; publishedAt: string; pages: number; sharedResources: number };
type LocaleReleaseHistoryEntry = LocaleReleaseSummary & {
  operation: 'publish' | 'rollback';      // その版を作った操作（公開／戻し）
  by: string | null;                      // 操作した人（人が読む名前）
  restorable: boolean;                    // この版に戻せるか
};
type LocaleReleaseProgress = { done: number; total: number };          // 0 <= done <= total、total >= 1
type LocaleReleasePending = {                                          // 途中で止まっている公開・戻し
  operation: 'publish' | 'rollback'; stage: 'prepare' | 'apply';
  progress: LocaleReleaseProgress; resumeToken: string;
  releaseId: string | null;               // 戻しの行き先（公開は null）
  startedAt: string; startedBy: string | null;
};
type LocaleReleaseBlocker = { id: string; message: string; itemKey: string | null };   // 公開できない理由
type LocaleReleaseWorkspacePlan = {
  confirmationToken: string; expiresAt: string;   // 確認の期限（推奨 2 分）
  address: string;                                // 公開する先（https の URL。例 "https://example.test/en/"）
  pages: number;                                  // 公開するページの数
  previous: LocaleReleaseSummary | null;          // 今の公開中の版
  prepared: LocaleReleaseSummary;                 // これから公開する版
  changes?: {                                     // 公開ページ集合の差分を返すサイトが使う。返さなければ null として扱う
    added: { path: string; title: string }[];     // 今の版から新しく出るページ（500 件まで）
    removed: { path: string; title: string }[];   // 今の版から外れるページ（500 件まで）
  } | null;
  firstRelease?: {                               // 初回の publish だけ。古い adapter は省略可
    groups: { label: string; pages: number; automaticPages: number }[]; // groups の pages 合計は plan.pages
    excluded: { count: number; examples: { path: string; title: string; reason: string }[] }; // examples は最大 20 件
  } | null;
};
```

`readRelease` の応答は `{ status: "ready", current, history, pending }` です。`history` は新しい順で、`current` と同じ版を含みません。

公開の手順（ダイアログ）:

1. 概要を読み直し、`blockers` が 1 つでもあれば一覧を出して先へ進めません（`itemKey` があれば「開く」で 1 件へ移れます）。
2. 準備: `prepareRelease({ operation: "publish", releaseId: null, expectedVersion: overview.version, expectedCurrentVersion: current?.version ?? null, resumeToken: null })`。`preparing` なら `progress`（n/m）を出し、返った `resumeToken` を付けてすぐ呼び直します。`ready` で確認へ。`blocked` なら 1. の一覧に戻ります。`conflict` は「内容が変わりました。読み込み直して、もう一度試してください」。
3. 確認: ページ数・公開する先・今の版 → 新しい版・期限の残り（`expiresAt` まで）を出します。初回公開の `firstRelease` があれば、まとまりごとのページ数と、そのうち未確認の自動訳があるページ数、対象外の件数と理由を出します。`changes` があれば、新しく出るページと外れるページも出します。公開で `pages` が 0 になるとき（すべて外れる）は、そのことをはっきり出します。期限が切れたら「準備し直す」だけを出します。
4. 反映: `applyRelease({ confirmationToken, resumeToken: null })`。`applying` なら n/m を出し、`resumeToken` を付けて `applyRelease({ confirmationToken: null, resumeToken })` を呼び直します。`applied` で完了、`expired` は 2. からやり直し、`conflict` は読み直し。

- 途中で閉じても、サイトは途中の状態を `overview.release.pending`（と `readRelease` の `pending`）で返してください。画面は帯に「前回の公開が途中です。」と「続ける」を出し、`stage` に合わせて `prepareRelease` か `applyRelease` を `resumeToken` だけで呼び直します（`publish`・`rollback` の権限が要ります）。
- `confirmationToken` は URL・ログ・保存先に出さないでください。画面もタブのメモリにだけ持ちます。準備・反映の `resumeToken` も一回の公開の中でだけ使えるものにしてください。
- **ページ単位の公開。** サイトは、訳がそろったページだけを公開してよいです（未訳のページは原文の言語のまま。言語の切替と hreflang も出たページだけ）。そのときの `blockers` は、公開そのものを止める理由（取り込み中・公開の途中・共通部分の訳が未確認で出せるページが無い、など）だけにし、未訳の項目は並べません。出る・外れるページは `changes` で返します。
- 戻し: 公開の履歴で `restorable` の版を選び、`prepareRelease({ operation: "rollback", releaseId, … })` から同じ手順です。戻しは前に公開した版をそのまま戻すので、`blockers` で止めません（サイトが止める理由を返したときは出します）。
- 権限の確かめ: 公開は `publish`、戻しは `rollback` です。

### 設定（saveSettings）

画面で変えられるのは `autoDraft` だけです。有効にすると、原文の変更箇所を自動翻訳します。自動翻訳のままの訳は新しい訳で更新し、人が直した・確認した訳は保持して新しい訳を翻訳案に残します。自動翻訳のままでも公開できます。翻訳サービスの接続の有無・待っている件数・失敗と次の再試行は読むだけです。`expectedVersion` は `settings.version` で、違えば `conflict` と最新の `settings` を返します。

### 画像（uploadImage・pickAsset）

```ts
type LocalizationImageResult = { status: 'uploaded' | 'picked'; image: LocalizationImage };
```

画面は返った `image.asset` を `set-image` でそのまま送ります。`url` は表示用で、https か `/` から始まる同じサイトの path だけです。画像の種類・大きさ・権限はサイトが確かめます。

## プレビューの枠（postMessage の約束）

サイトの描画のコードは画面に入れません。サイトが公開している origin に、描画用の静的なページ（枠）を置き、画面はそれを iframe で開いて材料を postMessage で渡します。

- 画面は `overview.preview.frameUrl`（https。開発用に `http://localhost`・`http://127.0.0.1` も可。fragment なし）に `#niho-preview=<nonce>` を付けて開きます。iframe は `sandbox="allow-scripts"`（`allow-same-origin` なし）・`referrerpolicy="no-referrer"` です。そのため枠の origin は opaque（`"null"`）になります。
- nonce は画面が開くたびに作る 32 文字の `[A-Za-z0-9_-]` です。
- 枠 → 画面: `parent.postMessage({ type: "niho-localization-preview", protocol: 1, nonce, event: "ready" }, "*")`。描いた後は `event: "rendered"`、描けなかったら `event: "error"`（`message` は任意の 1 行）。
- 画面は `event.source === iframe.contentWindow` と `type`・`protocol`・`nonce` が合うものだけを受け取り、ほかは捨てます（origin は opaque なので使いません）。
- 画面 → 枠（`ready` を受けた後と、切替・入力のたび）: `iframe.contentWindow.postMessage(message, "*")`

```ts
type PreviewRenderMessage = {
  type: 'niho-localization-preview'; protocol: 1; nonce: string; event: 'render';
  locale: 'ja' | 'en';                 // 表示する言語（原文か訳す言語）
  width: number | null;                // 表示の幅（PC は null、ほかは 360・320）
  materials: unknown[];                // loadPreview の material を届いた順に並べたもの
  overrides: { unitId: string; value: string | LocalizedRichText | LocalizationImage | null }[];   // 画面が今持っている各項目の訳文（まだ保存していない入力を含む。null は訳文なし・原文の画像）。訳す言語のときだけ
};
```

- 枠は `overrides` の値を材料の訳文より優先して描きます（材料は 1 件を開いたときに読むだけなので、保存した後の値も `overrides` で届きます）。
- 枠は `event.source === window.parent` と、自分の URL の fragment の nonce が合うものだけを受け取ります。
- 枠はリンクの移動・フォームの送信・動き（アニメーション・自動再生）を止めて描きます。外へ通信する必要があるもの（フォントなど）はサイトの公開 origin から読み、CORS を確かめてください。
- 送る先が opaque な origin なので、targetOrigin は `"*"` です。材料に秘密を入れないのはこのためです。

## 画面のふるまい

一覧:

- 上に「{訳す言語}版」の帯: 公開中の版と日時、確認済み n/m 件、「{訳す言語}版を公開…」（`publish`）、「公開の履歴」、原文の取り込みの進み具合、途中の公開の「続ける」。初回公開を止める `blockers` があれば件数と公開ダイアログへの案内を表示する。翻訳サービスが未接続なら、翻訳案は作れないが手入力はできることを表示する。確認済み件数だけで公開可能とは判定しない。
- 左にコンテンツの種類と件数（「すべて」を先頭に）。幅 900px 以下は上に横並び。
- 絞り込み: 初回は「要対応」。要対応／確認済み／すべて／対象外（件数つき）を切り替えられる。検索を始めると全件から題名とアドレスを探し、項目から一覧へ戻ったときは元の行を見つけられるよう「すべて」を表示する。「要対応」が空なら「すべてを見る」で切り替えられる。
- 行: 状態の印（形と言葉）・題名（下にアドレス）・任意の「含むもの」・確認済み n/m・未確認の画像の数・最終更新。対象外は `excludedReason` ごとに見出しと件数をまとめ、題名・アドレス・理由で検索できる。ホストが同じページや項目の部品を 1 件に集約し、内部名の代わりに `includedParts` へ人が読む名前を返す。`editLink` が安全な URL を返す行はホストのサブ言語編集画面へ移り、無ければこの画面の項目を開く。`sourceLink` が安全な URL を返す行には「原文を編集」を出す。
- 「すべて」と各種類では、対象外の行を一覧の下の折りたたみへ分ける。検索中は一致した対象外も見えるように開く。「対象外」の絞り込みでは直接一覧に出す。

1 件の編集:

- 上のバー: 「‹ 一覧へ」・状態・保存の状態・「翻訳案を作る」（`translate`）・「CMS で開く」（`sourceLink`）。
- 原文の CMS に未公開の下書きがあれば帯で知らせ、CMS への入口を出します。
- 「原文が更新」の項目は「原文が更新された項目」として先にまとめて出し、確認したときの原文（`previousSource`）を開いて見られます。
- 項目ごとに原文（読むだけ）と訳文を横に並べます（900px 以下は縦）。訳文は直してから `autosaveDelay` 後に自動で保存し、項目ごとに「確認済みにする」（`review`）・「翻訳案を使う」を出します。
- 保存の衝突（`conflict`）は上書きせず、その項目に「ほかの人が先に直しました」（原文の版が違うときは「原文が更新されました」）と「最新を読み込む」を出します。読み込むと、その項目でいま直したところは消えます。ほかの項目の入力は残します。
- 画像: 原文の画像と訳文の画像を並べ、「素材から選ぶ」（`pickAsset`）・「画像を上げる」（`uploadImage`）・「原文と同じに戻す」・「確認済みにする」。
- プレビュー: 右（1100px 以下は下）に枠を出し、表示するページ・幅（PC・360・320）・言語を切り替えます。まだ保存していない入力も映します。
- 保存待ちのまま一覧へ戻ると、先に保存します。保存できなければ「変更を捨てて戻る」かを確かめます。保存待ち・保存中にタブを閉じようとすると `beforeunload` で止めます。

共通:

- 状態は色だけでなく、印の形と言葉で示します。キーボードで操作でき、focus が見えます。ダイアログは Esc で閉じ、Tab は中で回り、閉じると開く前の場所へ focus を戻します。320px でも横にはみ出しません。
- 内部の英語の識別子・`⟦id⟧`・token は画面に出しません。
- adapter を替える・閉じる・別の 1 件へ移ると、進行中の読み込みを abort し、遅れて届いた古い応答は捨てます。

## 当初の案から変えた点

- `command` の CAS を、1 件の版ではなく項目（unit）ごとの「項目の版」と「原文の版」にしました（同じ 1 件の別の項目を同時に直せるように）。
- 翻訳案は `candidateId`（不透明な文字列）で指します。
- 準備と反映を `progress` と `resumeToken` で分けて進め、途中から再開できるようにしました。
- `listItems` は `cursor` で段階に返します。

## デモと検証

`npm run demo:localization-workspace`（`http://127.0.0.1:4180`）で、架空のデータとメモリ上の adapter で動く画面と、デモ用の描画の枠を出します。

`test/localization-workspace-model.test.mjs` は parser（未知の key・大きすぎる値・印の対応・状態の組み合わせ）と、印・リッチテキストの札の変換を確かめます。`test/localization-workspace-ui.test.mjs` は jsdom で、一覧・絞り込み・自動保存・確認済み・衝突・札・公開の手順（理由・再開・戻し）・権限・古い応答の破棄を確かめます。
