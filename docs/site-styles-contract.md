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

ページは style version を保持しません。編集・検証はサイトの現在の `draft.styles`、HTMLを新しく生成するときは現在の `published.styles` を使います。Studio-native managed siteでは、既存HTMLを再生成する接続は#527で追加します。ページごとの `stylesVersion`、site publication epoch、migration/publication fenceは使いません。

実効値は token と文字スタイルごとに `site → page` の順で重ね、同名はページ定義が丸ごと優先します。サイトの文字スタイルはサイトのtokenだけで検証します。`PageRenderer`、`renderPageToHtml`、`generatePageCss`、`resolvePageDocument` は同じ解決規則を使います。生成されるHTMLは、その生成時点のpublished style snapshotを反映します。

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

ホストはedit全体を一つのstorage transactionで処理します。Studio-native managed siteでは、draftまたは公開中のページが参照するtoken・文字スタイルのrename/deleteを拒否し、参照するページのusageを返します。token renameでは、サイト文字スタイル内のtoken参照を同じedit内で更新します。rename先の衝突、型不一致、未解決参照は書込み前に拒否します。

tokenまたは文字スタイルをdeleteするとき、ホストは全参照を列挙します。参照が1件でもあれば何も書かず、`{ status: "referenced", usages }` を返します。usageはkind、安定ID、任意のlocale/pathを持ち、GUIとCLIは利用箇所を表示します。未参照の定義だけ削除できます。値更新と追加も、変更後のdraft全体を信頼境界で再検証してから保存します。

publishはdraft版とpublished版をCASし、サイト単位のpublished pointerを一度に切り替えます。request時に描画するhostは次の描画から新しいsnapshotを使い、Studio-native managed siteは新たに生成するHTMLから使います。既存HTMLの一括再生成は#527の共通公開経路で接続します。ページ公開・rollback・release-setのrequestやplanにstyle版やepochを含めません。

## CLI

```sh
niho-edit --origin https://site.example --site sample styles read
niho-edit --origin https://site.example --site sample styles edit --json edits.json
niho-edit --origin https://site.example --site sample styles publish --json publish.json
```

GUI用の `createEditingApiSiteSettingsFacade` はスタイル差分を同じ `site.styles.edit` へ変換します。別のGUI専用保存経路は作りません。409では入力を保持し、`referenced` では返された利用箇所を表示します。

GUIでは表示ラベルと識別名を別に編集できます。識別名の変更は `rename` edit として送信します。ページ参照が残っている場合はusageを表示し、参照を解消してから変更します。下書きを保存した後、公開済み版との差があればスタイルパネルから公開できます。公開は `site.settings.write` と `pages.publish` の両方を要求し、draft・publishedの版を指定して一度でpointerを切り替えます。

## 正規化とlint

normalizationは既存文書を一度だけ整理する移行ツールとして残します。通常編集やpublishのたびには実行しません。計画・明示承認・版照合・undo/verifyの既存手順を使います。

lintは継続利用しますが、役割を保存データを変更しない軽量検査に限定します。未使用のページtoken、既存tokenと同値のリテラル、冗長な幅別上書き、名前のない大きなsection、未使用breakpointを報告します。参照整合性と型検証は保存時のparser/APIが担うため、lintをmigration fenceやpublish条件にはしません。

## ホスト実装条件

- `read` は同一snapshotからdraft/publishedを返す。
- `edit` はsite IDとdraft versionを照合し、参照列挙・rename書換え・定義変更を一つのtransactionで確定する。
- `publish` はdraft/published versionを照合し、site-wide published pointerを原子的に切り替える。
- 新たに描画・生成するページは現在のpublished stylesを共有し、過去の履歴snapshotを変更しない。既存Studio-native HTMLの再生成は#527で接続する。
- site/project scopeを各層で検証し、別サイトの参照を書き換えない。
- Studio-native managed siteのstyle snapshotはR2のimmutable object、版pointerとdigestはD1で保持する。snapshotは256 KiBまで、参照中の履歴はmanaged CMSと同じ100 MiB上限に従う。
