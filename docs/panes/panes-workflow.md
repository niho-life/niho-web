# 作業座席と topic branch の運用

この文書は既存 seat の再利用と topic branch の準備を定めます。作業範囲・公開境界などの規則は [AGENTS.md](../../AGENTS.md)、開発・検証方法は [README の開発節](../../README.md#開発) が正です。

## 座席の状態

作業は既存の `niho-web-paneB-1`〜`niho-web-paneB-3` で行い、owner の明示なしに seat / clone を増やしません。

```sh
scripts/seat.sh status
```

- `空き`: detached の座席に変更や保存先のない commit がありません。
- `再利用可・branch保持`: clean な topic branch が checkout 済みです。branch があるだけでは使用中と判断しません。
- `変更あり・保護`: 未コミット差分があるため切り替えません。
- `要確認`: detached HEAD に remote 未到達 commit があります。branch を付けて保護してください。
- `なし`: seat が存在しません。新設しません。

clean な topic branch から新しい作業を始めると、旧 branch ref を残したまま seat を再利用できます。同じ seat の同時編集は避け、作業差分のある seat は保護します。

## 新しい作業を始める

選んだ `niho-web-paneB-N` に移動して実行します。

```sh
cd ../niho-web-paneB-1
scripts/seat.sh start site-header-alignment
```

`start` は最新 `origin/main` から `paneB-<N>/<topic>` を作ります。現在の branch ref は残します。同名 branch が既にあれば停止し、ref を上書きしません。未コミット差分、または ref のない detached commit があれば停止します。

## 作業終了

```sh
scripts/seat.sh release
```

clean な seat を最新 `origin/main` に detach します。以前の topic branch は削除されません。別端末でも必要な commit は push してください。stash は使いません。
