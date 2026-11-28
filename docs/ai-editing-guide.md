# AI による Studio 内サイトの編集

AI は Studio の下書きを編集し、保存内容と公開範囲を確かめてから公開します。公開 HTML を直接編集しません。Studio が正本で、GUI と `niho-edit --studio` は同じデータと API を使います。

## 接続

Node.js 22 以上と Studio への認証が必要です。Access の短期 token は `NIHO_EDIT_TOKEN`、サービス認証を使う場合は対になる `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` を環境から渡します。認証情報をコマンド引数、編集ファイル、Issue、ログへ書かないでください。

コマンドには Studio の origin と対象 site ID を指定します。

```sh
niho-edit --studio --origin https://studio.example --site site-id discover
```

## 標準の手順

サイトをファイルとして取り出し、直して、手元で確かめ、保存してから公開します。

```sh
niho-edit --studio --origin https://studio.example --site site-id pull ./site
# ./site のファイルを直す（pages/・cms/・site/）
niho-edit --studio --origin https://studio.example --site site-id check ./site --html ./preview
niho-edit --studio --origin https://studio.example --site site-id push ./site
niho-edit --studio --origin https://studio.example --site site-id publish --changed
```

- ファイルの形・state・終了コードは [Studio CLI の契約](studio-cli.md#ファイル同期pullcheckpush) にあります。`.niho/` は CLI のものなので編集しません。版や操作 ID を自分で扱う必要はありません。
- `check` はサーバーに問い合わせず、変わったファイルを検証します。errors を直してから `push` します。`--html` の出力は本文の参考描画で、head・CMS・埋め込みは公開時に描かれます。
- `push` は変わったファイルだけを下書きに保存し、公開しません。保存後に `publish --changed` で未公開の変更をまとめて公開します。
- 新しいページは `page-change`、新しい CMS 項目は `cms-create` で作ってから `pull` し直します。ファイルを足しただけでは作られません。
- `cms/<collection>/<item>.json` を直して `push` した CMS 項目も、`publish --changed` でページと一緒に公開されます。公開予約がある間は CMS 項目は対象外です。
- ページに紐づく CMS binding はファイルに含めません。変更は `apply --cms-bindings` を使います。

### 競合したとき

`push` や `pull` が競合を報告したら、そのファイルは保存・上書きされません。他の人の変更を確かめ、自分の変更をやり直します。

1. 自分の変更を控えます（差分やコピー）。
2. 競合したファイルを消して `pull` し直し、サーバーの最新を取ります。
3. 控えた変更をもう一度入れ、`check`・`push` します。

他のファイルの保存は続くので、競合したファイル以外は保存済みです。

## 一部だけ読む・直す

大きなページの一部だけを見る、または直すときは、次の補助を使います。まず `pages-catalog` で対象ページを確認します。ページ全体が必要なときは `read` で文書と版を読み、狭い変更では `outline`・`find`・`get` で対象箇所だけ確認します。

```sh
niho-edit --studio --origin https://studio.example --site site-id pages-catalog
niho-edit --studio --origin https://studio.example --site site-id outline home --locale ja --depth 2
```

文章や属性など一部の変更は、`apply` に必要な操作だけを渡します。直前に読んだ版を指定し、サーバー側の版照合を通します。

```sh
niho-edit --studio --origin https://studio.example --site site-id apply home --locale ja \
  --ops edits.json --expected-version '<read-version>' --operation-id '<uuid-v4>'
```

保存後は応答の版と差分を確かめ、Studio のプレビューで表示を確認します。ファイルにない操作（`site-seo-*`、`site-public-*`、`site-redirects-*`、`styles` の rename など）も、専用の操作で行えます。版が競合したら最新を読み直し、意図した変更だけを適用し直します。古い文書をそのまま保存して上書きしないでください。

## 公開する

ページの公開は、そのページの下書きを1回の操作で公開します。保存済みの版を確認し、公開対象をコマンドに明示します。

```sh
niho-edit --studio --origin https://studio.example --site site-id publish home --locale ja --expected-version '<saved-version>'
```

複数の変更は `changes` で一覧を確認し、すべてをまとめて公開します。一覧にはページ・共通設定・CMS 項目が入ります。共通設定だけを公開する場合も専用の操作を使います。

```sh
niho-edit --studio --origin https://studio.example --site site-id changes
niho-edit --studio --origin https://studio.example --site site-id publish --changed
niho-edit --studio --origin https://studio.example --site site-id publish --site
```

日常の編集で `publish --all` は使いません。これは初回移行や生成コード変更後の全ページ再生成に限る CLI 操作です。

公開後の履歴と復元は次のとおりです。サイト全体を戻す場合は履歴の release ID を使い、ページだけを戻す場合はページ履歴から版を選びます。

```sh
niho-edit --studio --origin https://studio.example --site site-id site-history
niho-edit --studio --origin https://studio.example --site site-id rollback '<release-id>'
niho-edit --studio --origin https://studio.example --site site-id history home --locale ja
niho-edit --studio --origin https://studio.example --site site-id restore home '<revision>' --locale ja --expected-version '<current-version>'
```

公開応答の URL・警告・処理時間を記録し、公開サイトの表示を確認します。通信が切れた場合は、新しい公開を始める前に履歴と現在の版を読み、結果が反映済みか確かめます。

## 旧ホストの手順

鎌倉の切り替えが終わるまでは旧ホスト経路も残っています。その経路は `--studio` を付けない既存の `apply`・`release-plan`・`release` を使います。これは移行期間だけの手順で、Studio 内サイトの標準手順とは分けて扱います。切り替え後は外部ホスト向けの経路を #492 で撤去します。

詳細な引数と JSON 形式は [Studio CLI の契約](studio-cli.md) を参照してください。
