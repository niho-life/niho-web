# サイト共通スタイル契約

サイト全体で共有する token と文字スタイルを、保存・描画・編集で同じ規則にする契約です。ページ JSON の schema と、既存ページの見た目は変更しません。

## 状態と描画

サイト共通スタイルには `draft` と `published` の2状態だけがあります。

```ts
type SiteStylesSnapshot = {
  draft: { version: string; styles: SiteStyles };
  published: { version: string; styles: SiteStyles };
};
```

ページは style version を保持しません。編集・検証はサイトの現在の `draft.styles`、公開描画は現在の `published.styles` を使います。公開pointerを切り替えると、公開中の全ページが同じ新しいスタイルを参照します。ページごとの `stylesVersion`、site publication epoch、migration/publication fenceは使いません。

実効値は token と文字スタイルごとに `site → page` の順で重ね、同名はページ定義が丸ごと優先します。サイトの文字スタイルはサイトのtokenだけで検証します。`PageRenderer`、`renderPageToHtml`、`generatePageCss`、`resolvePageDocument` は同じ解決規則を使います。公開配信はページと、その時点のサイトのpublished style snapshotを組で読みます。

## 共通操作

GUIのスタイルパネルと `niho-edit styles` は、どちらも次の `site.styles.*` APIを使います。

| 操作 | 入力 | 結果 |
| --- | --- | --- |
| `site.styles.read` | site ID | `{ draft, published }` |
| `site.styles.edit` | `{ expectedVersion, edits }` | `saved`、`referenced`、または409競合 |
| `site.styles.publish` | `{ expectedDraftVersion, expectedPublishedVersion }` | `{ status: "published", version, styles }` または409競合 |

`edits` は1回のCASで適用する配列です。

```ts
type SiteStylesEdit =
  | { type: "set"; styleKind: "token" | "textStyle"; name: string; value: DesignToken | TextStyle }
  | { type: "delete"; styleKind: "token" | "textStyle"; name: string }
  | { type: "rename"; styleKind: "token" | "textStyle"; from: string; to: string };
```

ホストはedit全体を一つのstorage transactionで処理します。renameは定義と、draft page・template・shared document・component・presentation・locale・サイト文字スタイルにある全参照を同じtransactionで書き換えます。一部だけをrenameした状態を見せません。rename先の衝突、型不一致、未解決参照は書込み前に拒否します。

tokenまたは文字スタイルをdeleteするとき、ホストは全参照を列挙します。参照が1件でもあれば何も書かず、`{ status: "referenced", usages }` を返します。usageはkind、安定ID、任意のlocale/pathを持ち、GUIとCLIは利用箇所を表示します。未参照の定義だけ削除できます。値更新と追加も、変更後のdraft全体を信頼境界で再検証してから保存します。

publishはdraft版とpublished版をCASし、サイト単位のpublished pointerを一度に切り替えます。公開ページを個別に再公開せず、全公開ページが新しいpublished stylesを解決します。ページ公開・rollback・release-setのrequestやplanにstyle版やepochを含めません。

## CLI

```sh
niho-edit --origin https://site.example --site sample styles read
niho-edit --origin https://site.example --site sample styles edit --json edits.json
niho-edit --origin https://site.example --site sample styles publish --json publish.json
```

GUI用の `createEditingApiSiteSettingsFacade` はスタイル差分を同じ `site.styles.edit` へ変換します。別のGUI専用保存経路は作りません。409では入力を保持し、`referenced` では返された利用箇所を表示します。

GUIでは表示ラベルと識別名を別に編集できます。識別名の変更は `rename` edit として送信し、ホストがページを含む全参照を同じedit transactionで更新します。下書きを保存した後、公開済み版との差があればスタイルパネルから公開できます。公開は `site.settings.write` と `pages.publish` の両方を要求し、draft・publishedの版を指定して一度でpointerを切り替えます。

## 正規化とlint

normalizationは既存文書を一度だけ整理する移行ツールとして残します。通常編集やpublishのたびには実行しません。計画・明示承認・版照合・undo/verifyの既存手順を使います。

lintは継続利用しますが、役割を保存データを変更しない軽量検査に限定します。未使用のページtoken、既存tokenと同値のリテラル、冗長な幅別上書き、名前のない大きなsection、未使用breakpointを報告します。参照整合性と型検証は保存時のparser/APIが担うため、lintをmigration fenceやpublish条件にはしません。

## ホスト実装条件

- `read` は同一snapshotからdraft/publishedを返す。
- `edit` はsite IDとdraft versionを照合し、参照列挙・rename書換え・定義変更を一つのtransactionで確定する。
- `publish` はdraft/published versionを照合し、site-wide published pointerを原子的に切り替える。
- 公開描画は現在のpublished stylesを全ページで共有し、過去の履歴snapshotを変更しない。
- site/project scopeを各層で検証し、別サイトの参照を書き換えない。
