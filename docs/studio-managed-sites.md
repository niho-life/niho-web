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
