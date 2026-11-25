# AIによるサイト編集手順

`niho-edit` は、ホストの編集APIを通じてページを読み、操作を検証して下書きへ適用し、公開計画を確認して公開します。公開HTMLを直接編集しないでください。ホストが公開したHTMLは生成物で、編集の正本ではありません。

## 接続

Node.js 22以上と、対象サイトの短期 `NIHO_EDIT_TOKEN` が必要です。ホストoriginとsite IDはホストの担当者から受け取ります。originは `https://` で始まるAPIのoriginを指定します。Accessで保護されたoriginでは、対になる `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` もプロセス環境へ渡してください。Studio-native CMSを使うときはStudio originを設定し、toolの `args` に `--studio` を加えます。Studioでは短期Access user tokenを `NIHO_EDIT_TOKEN` に渡すか、Service Authの対になる資格情報を渡してください（[Studio-native CMSのCLI契約](studio-cli.md#studio-native-cms)）。tokenとAccess資格情報をCLI引数、MCPのtool引数、編集ファイルへ入れないでください。

CLIは各コマンドの前に `--origin` と `--site` を指定します。

```sh
niho-edit --origin https://site.example --site site-id discover
```

MCPサーバーは同じCLIをstdioで呼びます。ツール名はCLIのコマンド名と一致し、`args` にそのコマンドの引数、`stdin` に `-` で読むJSON本文を渡します。MCP接続時のoriginとsiteは固定され、tool引数から変更できません。

Claude Codeの `.mcp.json` 例です。環境変数はシェルやSecret Managerから設定してください。

```json
{
  "mcpServers": {
    "niho-edit": {
      "type": "stdio",
      "command": "niho-edit",
      "args": ["--origin", "https://site.example", "--site", "site-id", "mcp"],
      "env": {
        "NIHO_EDIT_TOKEN": "${NIHO_EDIT_TOKEN}",
        "CF_ACCESS_CLIENT_ID": "${CF_ACCESS_CLIENT_ID}",
        "CF_ACCESS_CLIENT_SECRET": "${CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

Codexの `config.toml` 例です。`env_vars` は親プロセスの環境から渡す変数を選びます。

```toml
[mcp_servers.niho_edit]
command = "niho-edit"
args = ["--origin", "https://site.example", "--site", "site-id", "mcp"]
env_vars = ["NIHO_EDIT_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]
```

Studio-native CMSでは、MCP設定のoriginをStudio originにし、`cms-discover` / `cms-v2` などのtoolを呼ぶとき `args` に `--studio` を加えます。CLIと同じくCMS系以外のサイト編集コマンドはこのモードでは実行できません。

## 読む・探す

まず `outline` でページ構造を確認します。対象を特定したら `find` または `get` で必要な部分だけ読みます。長いページをまるごと読むより、操作対象の安定IDと現在値を確認してから変更してください。

CLIの例:

```sh
niho-edit --origin https://site.example --site site-id outline home --locale ja --depth 2
niho-edit --origin https://site.example --site site-id find home --locale ja --text "古い見出し"
niho-edit --origin https://site.example --site site-id find home --locale ja --name heroTitle
niho-edit --origin https://site.example --site site-id find home --locale ja --uses-token brand
niho-edit --origin https://site.example --site site-id get home heading --locale ja
```

MCPでは同じ操作を `outline` / `find` / `get` ツールで呼び、引数列を `args` に渡します。`find --name` は名前、`find --uses-token` は利用するdesign token、`get` のnode IDはページ文書のアンカーです。`read` の結果には編集対象の文書と `version` が含まれます。

## 直す・確かめる

編集はページ操作のJSON配列にします。次の例は見出し文字列と `brand` tokenの色を変更します。IDは、対象ページの `outline` / `find` / `get` が返した値に置き換えてください。

```json
[
  { "type": "text", "parentId": "heading", "childPath": [0], "value": "新しい見出し" },
  { "type": "style", "nodeId": "heading", "breakpoint": "base", "property": "color", "value": { "token": "brand" } }
]
```

最初に `apply --dry-run` を実行します。`stdin` に上のJSONを渡し、`expected-version` には直前に読んだ版、`operation-id` にはUUID v4を指定します。応答の `status`、`diff`、`touched`、`validation` を確認し、対象・文字列・tokenが意図どおりであることを確かめてください。

```sh
niho-edit --origin https://site.example --site site-id apply home --locale ja \
  --ops - --dry-run --expected-version '<read-version>' \
  --operation-id '<uuid-v4>' <<'JSON'
[{"type":"text","parentId":"heading","childPath":[0],"value":"新しい見出し"},{"type":"style","nodeId":"heading","breakpoint":"base","property":"color","value":{"token":"brand"}}]
JSON
```

差分を確認してから、同じ操作を `--dry-run` なしで適用します。MCPの場合は同じ `apply` ツールを使い、`args` から `--dry-run` を外し、同じJSONを `stdin` に渡します。下書きが保存されたら `preview` で表示幅ごとの確認を行います。ホストがpreviewを提供しない場合は、公開計画へ進む前にホスト担当者へ確認してください。

MCPのtool入力は次の形です。`preview` は `--widths 375,768,1280` を加えて呼び、実適用とpreview後に `release-plan` を呼びます。

```json
{
  "name": "apply",
  "arguments": {
    "args": ["home", "--locale", "ja", "--ops", "-", "--dry-run", "--expected-version", "v1", "--operation-id", "123e4567-e89b-42d3-a456-426614174000"],
    "stdin": "[{\"type\":\"text\",\"parentId\":\"heading\",\"childPath\":[0],\"value\":\"新しい見出し\"},{\"type\":\"style\",\"nodeId\":\"heading\",\"breakpoint\":\"base\",\"property\":\"color\",\"value\":{\"token\":\"brand\"}}]"
  }
}
```

## 公開する

適用結果の最新 `version` を使い、`release-plan --action publish` で公開計画を作成します。計画のsite、page、locale、版、差分を確認してから、同じ計画を `release` に渡します。公開時の `operation-id` は先に決め、通信が途切れて結果を受け取れない場合も、同じ計画と同じIDで状態を確かめて再試行してください。

```sh
niho-edit --origin https://site.example --site site-id release-plan home --locale ja \
  --action publish --expected-version '<applied-version>' > release-plan.json
niho-edit --origin https://site.example --site site-id release home --locale ja \
  --json release-plan.json --operation-id '<uuid-v4>'
```

MCPでは `release-plan` の応答をレビューし、そのJSONを次の `release` ツール呼出しの `stdin` に渡して `--json -` を指定できます。確認していない公開計画は適用しないでください。

```json
{
  "name": "release",
  "arguments": {
    "args": ["home", "--locale", "ja", "--json", "-", "--operation-id", "<new-uuid-v4>"],
    "stdin": "<reviewed-release-plan-json>"
  }
}
```

## 競合・検証エラー

- **409 `version_conflict`**: `read` で最新文書と版を取り直し、意図した変更を現行文書へ当て直します。新しい版で `apply --dry-run` からやり直してください。古い操作をそのまま再送しないでください。
- **422の検証エラー**: 応答の `index`、`nodeId`、`reason` を使って該当操作を修正し、もう一度dry-runします。検証エラーを無視して公開へ進みません。
- **応答を受け取れないタイムアウト**: 書込結果を読み直すか、同じ入力・同じoperation IDで再試行します。別の入力に同じIDを使わず、新しい操作を始める場合は新しいUUID v4にします。

## MCPツールとCLIの対応

`niho-edit --help` に掲載する各コマンドを、同名のMCP toolとして提供します。toolはCLIと同じ引数列を `args` で受け、標準入力を使うコマンドは `stdin` を渡します。実行、認証、入力検証、応答形式は既存CLIを通るため、MCP専用の編集操作はありません。
