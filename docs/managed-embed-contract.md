# ManagedEmbed の保存・公開契約

`ManagedEmbed` は、外部サービスのコードをページ文書で実行する汎用 HTML 枠ではありません。ページ文書には opaque な `refId` と背景・初期高さなど安全な外観だけを保存し、iframe URL と配布 token はホストの private storage に置きます。

Kamakura 接続では「追加」に出す業務ブロックを `ManagedEmbed` だけに限定します。NIHO の iframe URL または snippet を専用設定 UI に貼ると、ブラウザと Kamakura Worker の両方で origin、`/embed/dropin|rental/…`、query、token payload の flow・親 origin・許可 path を検査します。`&amp;` は URL の `&` に戻しますが、snippet の script、style、event 属性は保存も実行もしません。NIHO API の検証鍵を Kamakura が持たないため、画面には「形式確認済み、実接続は公開先で確認」と表示し、署名確認済みとは表示しません。

接続設定は Studio の認証と Kamakura bridge の HMAC 署名を通して private R2 に CAS 保存します。公開 plan はページ内の全参照と接続設定の版を固定し、設定の後発更新、未設定参照、別ページ・別 origin の参照を拒否します。公開時は文書 revision と接続設定の不変 snapshot を対応させ、rollback はその revision の snapshot を復元します。公開中の解決情報を閉じてから新しい文書を反映するため、途中失敗時は以前の token を誤表示せず fail closed になります。

公開 HTML は URL を含まず `refId` の placeholder だけを描きます。同一 origin の Worker API は現在の path に対応する公開済み参照だけを URL に解決し、信頼済み `niho-embeds.js` が iframe を生成します。親 URL は origin と path だけを NIHO へ渡し、resize、申込完了、checkout は NIHO origin と対象 iframe window の両方を照合します。Studio キャンバスは接続しない表示サンプルを使います。


ブラウザの親 origin 検証には、検証済み catalog の現在の公開ドメインを渡します。catalog は既知の確認用・本番ドメインを1つだけ受け入れ、Project と Site の値も一致を必須にします。両方を同時に接続先として許可せず、現在の公開先と異なる token は拒否します。公開先の切替時は新しい接続参照を作ってページを公開し、既存参照の origin を上書きしません。

## Studio-native site

オーナーが公開配信の設定で NIHO の本番 origin を許可した後、ページエディターで「NIHO フォーム」を追加し、NIHO がその公開先向けに発行した iframe URL を入力します。接続設定は `POST /api/projects/{projectId}/sites/{siteId}/editor/{pageId}/embed-connection` に `{ locale, src }` を送って作成し、応答から `refId` だけを文書に保存します。接続先を変えると新しい参照を発行するため、公開中の版と復元対象の版は以前の接続を指し続けます。

URL は D1 の非公開テーブルに、サイト、ページ、locale、公開 origin、公開 path と合わせて保存します。ページの現在の公開版が同じ参照を持ち、接続先がサイト設定で許可されている間に限り、同じ公開 URL の `?_niho_embed={refId}` が `{ src }` を `Cache-Control: no-store` で返します。下書き、非公開ページ、他サイトや他ページの参照には返しません。新しい公開先や path では、その URL 用に発行したフォームを再接続します。

公開の JavaScript は許可済み参照があるページでだけ読み込まれます。親 URL の query と fragment は渡しません。iframe からの高さ調整・送信完了・決済画面への遷移は、送信元の origin と iframe window が一致する場合に処理します。入力と送信は NIHO の iframe 内で行います。
