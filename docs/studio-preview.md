# Studio Preview

素材アップロード・翻訳画面を受け入れるPreviewは、Studio production Worker、Kamakura production Worker、production D1/R2から分離します。Previewのhost名、Cloudflare account ID、Access issuer/AUD、D1 IDは公開リポジトリに置かず、~/.config/niho-web/studio-preview.env に保存します。

## 接続の境界

- Studio GUIは、ローカル設定のPreview hostを既存のNIHO staff Access policyで保護します。本番Access applicationやpolicyは変更しません。
- Studio側は専用Worker、D1、R2を使います。Kamakura側Service BindingはPreview専用internal Workerだけを指します。
- Kamakura Preview Workerはworkers.devを無効化し、Preview専用custom domainだけを持ちます。Preview用MEDIA/DRAFTS R2とadmin-preview branchを使います。
- ブラウザーの直接PUTと翻訳preview frameは、ローカル設定のpath-limited upload gatewayを通します。gatewayは一回限りtokenの検査を内部Workerへ渡し、Preview MEDIA R2にある画像の許可パスだけを配信します。サイト全体や一般APIは公開しません。
- GUIのPUTはcredentials: omitなのでgatewayにAccess cookieを要求しません。Studio GUIのAccessと、短命upload token・GUI/CUIのOrigin allowlistを別々に適用します。

## ローカル設定

~/.config/niho-web/studio-preview.env は権限を所有者だけにして、次の値を設定します。

```text
CLOUDFLARE_ACCOUNT_ID=
STUDIO_PREVIEW_WORKER_NAME=
STUDIO_PREVIEW_HOST=
STUDIO_PREVIEW_DATABASE_NAME=
STUDIO_PREVIEW_DATABASE_ID=
STUDIO_PREVIEW_CMS_BUCKET=
STUDIO_PREVIEW_ACCESS_ISSUER=
STUDIO_PREVIEW_ACCESS_AUDIENCE=
KAMAKURA_PREVIEW_WORKER_NAME=
KAMAKURA_PREVIEW_UPLOAD_ORIGIN=
KAMAKURA_PREVIEW_SITE_ORIGIN=
```

studio/wrangler.preview.template.tomlには公開できる構成だけを置きます。npm run studio:preview:wrangler -- <wrangler args> はローカル設定から一時configを作成し、Wrangler終了後に削除します。例:

```sh
npm run studio:preview:wrangler -- d1 migrations apply preview --remote
npm run studio:build
npm run studio:preview:wrangler -- deploy
```

## 初回構築と受入

1. Preview hostだけを対象にAccess applicationを作り、既存Allow NIHO Web Studio staff policyを割り当てます。staffのGoogle loginと会社メールdomainの既存条件を使います。
2. Kamakura repoでPreview用MEDIA/DRAFTS R2、internal Worker、upload gatewayを構成します。PreviewのMEDIA_ORIGINはgatewayを向けます。gatewayはupload API、翻訳frame、許可した画像keyだけを扱います。
3. 両Preview WorkerにPreview専用KAMAKURA_STUDIO_BRIDGE_SECRETを同じ値で設定します。本番secretを読み出したり複製したりしません。
4. Studio Preview D1へmigrationsを適用し、Studio Preview WorkerへPreview用Access issuer/AUD、upload origin、Kamakura Preview site originを設定してdeployします。
5. Preview /api/sessionで確認したsubjectだけをPreview D1へownerとして追加します。
6. niho-editとGUIで同じ合成素材を使い、list/read/upload-intent/direct PUT/metadata update/delete/restoreと版・audit情報を比較します。翻訳はlist/read/save/stale version 409、translation job、release-setの状態を比較します。

本番画像や本番D1/R2への書き込みは受入fixtureに使いません。Previewの新しいuploadはPreview R2へ保存し、gatewayが返す同じPreview media URLからGUIとCLIで読み戻します。
