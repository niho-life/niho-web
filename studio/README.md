# Studio 運用 runbook

ここには配備・migration・rollback・secret 管理の手順だけを記載します。機能や API の契約は対応する `docs/` を参照してください。

## 前提確認

- Node.js 22 以上、依存関係、Wrangler CLI を用意する。
- `studio/wrangler.toml` の Worker、D1 binding、環境設定が対象環境と一致することを確認する。
- Cloudflare Access の hostname・issuer・audience が同設定と一致することを確認する。
- production 配備は owner の依頼があるときだけ行う。production の secret や実データをローカル設定・Issue・ログへ書かない。

## Secret 管理

secret の値はコマンド引数・ファイル・ログへ書かず、Wrangler の対話入力で登録する。STG と production、NIHO API と Kamakura で値を共用しない。

```sh
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET_STG --config studio/wrangler.toml
wrangler secret put KAMAKURA_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
```

## Migration と配備

変更のある版だけ migration を適用し、その後 Worker を配備する。対象 D1 binding を確認してから実行する。

```sh
npm ci
npm run studio:typecheck
npm run studio:build
wrangler d1 migrations apply niho-web-studio --remote --config studio/wrangler.toml
wrangler deploy --config studio/wrangler.toml
```

配備後は Chrome で Studio に入り、認証、Dashboard、変更した画面の主要操作を確認する。Cloudflare で新しい Worker version と対応する asset 一式が有効になったことも確認する。実施した配備と結果は作業 PR に記録する。

初回 owner は Access の subject と email を別経路で確認した operator が、現在の D1 schema に沿って追加する。確認値や secret をリポジトリへ保存しない。

## Rollback

- Worker を最後に動作確認した版へ戻し、認証と変更対象の主要操作を確認する。
- Worker と内容 hash 付き UI assets は同じ build から戻す。Worker のみ戻して画面が一致しない場合は、対象 commit から再 build し、対応する asset 一式とともに配備する。
- D1 migration は Worker の rollback では戻らない。schema とデータが旧 Worker と互換かを確認し、互換でなければ逆操作を行わず前方修正を用意する。
