# NIHO Web Studio 運用

このファイルは Studio Worker の配備、D1 migration、secret、切り戻しの手順だけを記録します。画面機能と API 契約は、[共通編集 API](../docs/editing-api-contract.md)、[Studio CLI](../docs/studio-cli.md)、[Studio-native site](../docs/studio-managed-sites.md)を参照してください。

## 実行前確認

- Node.js 22 以上と Wrangler CLI を用意し、Cloudflare にログインした operator が操作します。
- 対象環境の Worker config、Cloudflare account、D1 database、Access application、custom domain を確認します。環境を取り違えないよう、ローカル設定と Cloudflare dashboard の双方で対象を照合します。
- secret 値、account ID、database ID、Access token、個人情報は repository、shell history、ログ、Issue、PR に記録しません。
- migration や配備の対象・差分・切り戻し手段を確認してから実行します。

## 検証と配備

    npm ci
    npm run studio:typecheck
    npm run studio:build
    wrangler deploy --config studio/wrangler.toml

本番 Worker の配備は owner の依頼がある場合だけ行います。配備後は Cloudflare の有効 version と、認証済みの Dashboard・対象機能 smoke を確認します。失敗時は途中の build や upload を成功扱いにしません。

## D1 migration

Migration source は studio/migrations/ にあります。適用済み migration の SQL を書き換えず、修正は新しい forward migration として追加します。適用前に対象 database と pending migration を確認し、データ復旧に必要なバックアップが利用可能であることを operator が確認してください。

    wrangler d1 migrations list <DATABASE_NAME> --remote --config studio/wrangler.toml
    wrangler d1 migrations apply <DATABASE_NAME> --remote --config studio/wrangler.toml

migration の後に Worker version を更新し、schema を使う画面の readback を確認します。schema とデータの互換性を確認できない場合は、適用を止めて復元計画を見直します。

## Secret

環境ごとに別の secret を使います。設定は Wrangler の対話入力または承認済みの secret handling で行います。値を command argument、env file、repository、ログへ出しません。

    wrangler secret put <SECRET_NAME> --config studio/wrangler.toml

更新後は対象環境だけで認証済み smoke を行い、secret 値そのものを出力して確認しません。

## Worker と asset の切り戻し

Cloudflare の version history から last known-good Worker version を特定し、対象環境へ戻します。Worker が参照する HTML / JS / CSS asset の hash が戻した version と一致することも確認します。version rollback だけで一致する asset が戻らない場合は、同じ source SHA から既知の asset bundle を再 build し、公式配備手順で反映します。

D1 schema migration は Worker version の切り戻しだけでは戻りません。データを削除・手編集せず、前進修正または確認済みの backup restore を使います。復元後は D1 と参照先 object の整合性を検証してから Worker を有効にします。
