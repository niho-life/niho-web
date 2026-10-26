# ManagedEmbed の保存・公開契約

`ManagedEmbed` は、外部サービスのコードをページ文書で実行する汎用 HTML 枠ではありません。ページ文書には opaque な `refId` と背景・初期高さなど安全な外観だけを保存し、iframe URL と配布 token はホストの private storage に置きます。

Kamakura 接続では「追加」に出す業務ブロックを `ManagedEmbed` だけに限定します。NIHO の iframe URL または snippet を専用設定 UI に貼ると、ブラウザと Kamakura Worker の両方で origin、`/embed/dropin|rental/…`、query、token payload の flow・親 origin・許可 path を検査します。`&amp;` は URL の `&` に戻しますが、snippet の script、style、event 属性は保存も実行もしません。NIHO API の検証鍵を Kamakura が持たないため、画面には「形式確認済み、実接続は公開先で確認」と表示し、署名確認済みとは表示しません。

接続設定は Studio の認証と Kamakura bridge の HMAC 署名を通して private R2 に CAS 保存します。公開 plan はページ内の全参照と接続設定の版を固定し、設定の後発更新、未設定参照、別ページ・別 origin の参照を拒否します。公開時は文書 revision と接続設定の不変 snapshot を対応させ、rollback はその revision の snapshot を復元します。公開中の解決情報を閉じてから新しい文書を反映するため、途中失敗時は以前の token を誤表示せず fail closed になります。

公開 HTML は URL を含まず `refId` の placeholder だけを描きます。同一 origin の Worker API は現在の path に対応する公開済み参照だけを URL に解決し、信頼済み `niho-embeds.js` が iframe を生成します。親 URL は origin と path だけを NIHO へ渡し、resize、申込完了、checkout は NIHO origin と対象 iframe window の両方を照合します。Studio キャンバスは接続しない表示サンプルを使います。
