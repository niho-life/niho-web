# Studio-native site 契約

Studio で作成した Project、Site、メンバー、ページの下書きと公開履歴は Studio の D1 に保存する。Studio GUI と公式 CLI は同じページ API を使う。外部ホストとして登録されたサイトは、各ホストの編集 API と権限を使う。

## 作成と識別子

`PUBLIC_SITES_ORIGIN` に、Studio の管理 origin と異なる HTTPS origin を正確な origin 形式で設定したときだけ、Project 一覧の「新規プロジェクト」を有効にする。例は `https://sites.example.com`。path、query、fragment、credential を含む値は無効とする。

認証済みの人がタイトル、公開スラッグ、localeを送ると、`POST /api/projects` は次を1つの D1 batch で作る。

- Project と Site
- 作成者を owner とする membership
- `managed_sites` の一意な公開スラッグ
- 未公開の home ページと revision 1
- 作成 audit

Project と Site の ID、ページの版はサーバーが発行する。共有公開 origin は `managed_sites` の登録から Project の表示に反映する。作成後の canonical editor URL は `/projects/{projectId}/sites/{siteId}/editor`。

## ページ正本と操作

`managed_pages` は編集中の版、公開中の版、公開範囲を保持する。`managed_page_versions` に現在の下書きと公開済みの版を保存し、下書きを保存するたびに公開されなかった前の下書きを削除する。復元では選んだ公開版の内容を新しい版として保存し、編集中の版と公開中の版に設定する。保存・公開・ページ情報の更新は `current_version` を SQL の更新条件に含める。競合時は HTTP 409 を返す。確認の有効期限は10分で、確認時の対象版と操作を実行時に照合する。

GUI と CLI が実装する操作は次だけである。

- page catalog と PageDocument snapshot の読取
- opaque version CASによる下書き保存
- 現在版の公開計画・公開
- 公開済みの指定revisionへの復元計画・反映
- 通常ページの作成、タイトル・path更新、visibility更新

URL 変更・非公開化の確認画面では、サイト内の他ページの下書きと公開版からリンク元を集計する。Discovery はこの集合だけを返す。すべての読取・変更は、そのrequest時点の D1 owner/editor membership と Project/Site を照合する。別siteのpage、plan、version、公開pointerは変更できない。

## 共有公開origin

公開ページは `PUBLIC_SITES_ORIGIN` の `GET` / `HEAD /s/{siteSlug}/...` で配信する。ホームの公開 URL は `/s/{siteSlug}/`。Worker はrequest originの完全一致を先に確認し、このoriginのそれ以外のpathを404にする。管理画面のassetやAccess応答は公開originから返さない。

公開対象はvisibilityがpublicで、現在の `published_revision` が指す不変PageDocumentだけである。root-relativeな本文リンク、画像、poster、favicon、OG画像には描画時に `/s/{siteSlug}` を付ける。保存文書は書き換えない。既存のserver-safe rendererとhead resolverを使い、title、canonical、robots/noindexを反映する。応答はscriptを含めず、`script-src 'none'`、`frame-src 'none'`、`form-action 'none'` を含む制限的なCSPを付ける。

## CLI認証

既存外部ホストと、operatorが明示的にgrantを設定済みのStudio-native siteは、従来のAccess service tokenと期限付きD1 grantを使える。新規Projectにservice grantがない場合は、Cloudflare Accessでmember本人が取得した短時間のapplication tokenを `cf-access-token` headerで受ける。Workerはブラウザと同じAccess JWT署名・issuer・audience・期限・subject・email検証を再利用し、さらに現在のD1 membershipへ固定する。CLI routeでcookie由来の `Cf-Access-Jwt-Assertion` だけを提示しても人のCLIとして認可しない。

CLIはtoken、service credential、Access subjectを標準出力へ含めない。操作の結果には既存の監査IDを付け、operation keyがある変更は同じactor・Project・Site内で重複受付を拒否する。取得手順は [Studio CLI](studio-cli.md) と [CloudflareのCLI向けAccess手順](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/) を参照する。

## CMS

Studio-native site の Dashboard にある「CMS」から、初期コレクション「お知らせ」の項目を編集する。owner はコレクションを追加でき、owner と editor は下書き保存、確認付き公開、公開予約、予約取消、公開の取り下げ、削除、下書きへの復元を行える。公開中の項目は先に取り下げ、予約中の項目は先に予約を取り消す。初期実装は home の言語を CMS 全体に使う。公開リストは `/s/{slug}/cms` と `/s/{slug}/cms/posts`、詳細は `/s/{slug}/cms/posts/{itemSlug}`。固定ページ用にこの名前空間を割り当てることはできない。本文はテキストとして描画し、公開素材の解決は後続フェーズで接続する。

Studio の共通編集 API と CLI の経路は [CMS v2 契約](cms-v2-contract.md) を参照する。CMS の保存先は Studio の D1 と非公開 R2 binding `CMS_OBJECTS`。Kamakura などの外部ホストの編集先や権限は各ホストで管理する。個人情報・予約台帳・資格情報などは CMS に保存しない。

## CMS の公開と復旧

- 項目の revision、release snapshot、locale ごとの route table は `sites/{siteId}/items/...`、`sites/{siteId}/releases/...`、`sites/{siteId}/routes/{locale}/{revision}.json` に不変オブジェクトとして置く。D1 state は最後に公開した snapshot の route table revision を保持する。CMS の計画時はStudioで管理する固定・予約 pathと組み合わせた現行版を作り、公開 snapshot に保存する。R2 の条件付き PUT により、同じキーの内容を上書きしない。
- 項目 blob のキーは site、actor、operation ID、入力 digest、項目の識別子から決まり、R2 書込みの応答が不明でも同じ要求は同じ blob を再利用する。D1 に参照が確定していない blob は公開されない。
- オブジェクト保存後に、D1 batch で同一世代への CAS、revision の登録、受領記録、監査、outbox を確定する。配信前の公開は現在の snapshot のまま。必要なオブジェクトが揃い、予約時と現在の公開版・定義が一致した時点で、公開 pointer と outbox 完了を同じ batch で確定する。固定ページの公開は別処理。
- Cron は毎分、期限到来の outbox を60秒の lease で取得する。一時的な障害は間隔を空けて最大5回まで試す。lease を持つ処理が中断した場合、期限後に別の実行が取得できる。公開前提の不一致と再試行上限は `dead` に残り、現在の公開版を保つ。再実行は現行の公開版・定義・項目版から新しい確認計画を作る。
- サイトごとに、復元可能な削除済み項目を含めて25項目、同時に25件の公開・予約、D1で確定したR2履歴は100 MiBまで。公開時はsnapshotとroute tableの各オブジェクトを履歴サイズに算入する。API 本文は64 KiB、単一 snapshot は最大2 MiB（確認計画にも収まる大きさが必要）。確定済み履歴を自動削除する期限はなく、上限到達時は新規保存が409になる。未確定の孤立オブジェクトは公開にも使用済み容量にも含めない。
- 死活確認は `managed_cms_outbox` の `kind`、`state`、`attempts`、`available_at`、`failure` を対象にする。失敗したジョブの行や公開ポインターは直接更新せず、現行版から再計画する。

### エクスポートと復元演習

1. 管理リクエストの書込みとCronを停止した隔離環境で、D1を `wrangler d1 export <DB> --output studio.sql` で書き出す。同じ時点の非公開 R2 bucket の `sites/` を、権限を限定した S3 互換クライアントで全件コピーし、キー、サイズ、SHA-256 の一覧を付ける。wrangler の `--local` または `--remote` は対象環境を明示する。SQL と R2 のコピーは同じ復元セットとして暗号化し、CMS の書込み再開より先に照合する。期限付きのトークン行が含まれるため共有範囲を運用担当者に限定する。[D1 のエクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/) [R2 の S3 API](https://developers.cloudflare.com/r2/api/s3/api/)
2. 新しいローカルまたは隔離 D1 に `wrangler d1 execute <DB> --file studio.sql --local` で読み込む。別の非公開 bucket に元のキーのまま R2 オブジェクトを戻し、サイズ・ハッシュと `managed_cms_revisions` / `managed_cms_releases` / 未処理の outbox が参照するキーを照合する。確認用の設定で D1 と bucket をバインドする。復元検証が終わるまで Cron を起動しない。
3. CMS の下書き API と公開一覧・詳細を読み、公開中と最新下書きが異なる場合はその状態が保たれていることを比較する。別サイトの snapshot / preview を表示できないこと、既存操作IDの受領記録が引けること、予約を再開する際に現行の owner / grant を満たすことを確認する。
4. ローカルの自動演習は `node --test test/studio-managed-sites.test.mjs`。テストは SQLite と条件付き PUT を検証する R2 fixture を同じ時点でエクスポートし、別インスタンスへ復元して公開 HTML、snapshot、下書きの revision を比較する。実際の Cloudflare リソースは利用しない。
