# 鎌倉専用ブロックの移行

鎌倉の保存済みページは、次の対応で Studio-native の標準描画へ移す。現行サイトのページ文書と表示契約は参照元として使う。

| 旧ブロック | Studio-native の形式 | 移行に必要なデータ |
| --- | --- | --- |
| `KamakuraCmsList`、`KamakuraCompanyDirectory`、`KamakuraRecentArticles` | 通常のカードと CMS 一覧 binding | 移行先のコレクションと field ID、カードの文書、絞り込みと並び順 |
| `KamakuraCmsDetail` | 通常の詳細文書と CMS 詳細 binding | 移行先のスラッグ field、表示に使う field ID と要素の対応 |
| `KamakuraCarousel` | 標準の carousel interaction | 現行の表示文書とスライド・操作の対応。自動再生、フェード、スワイプの設定を引き継ぐ |
| `KamakuraMapEmbed`、`KamakuraCalendarEmbed`、`KamakuraLegacyFrame` | 標準の `EmbedDescriptor` | 表示文書にある公開 iframe URL と、移行先サイトの許可 origin。自動高さなどホストの処理を使う枠は個別に確認する |
| `KamakuraDropInBooking`、`KamakuraRentalForm`、`KamakuraContactForm`、`KamakuraLegacyForm`、`ManagedEmbed` | `ManagedEmbed` | 移行先のサイト・ページで登録した新しい接続参照。旧フォームの入力欄・送信ボタンに専用スタイルを設定している場合は見た目を確認する |

## 保存前の変換

`npm run build` を済ませてから、読み取り用のページ一式と変換指定をローカルで渡す。このスクリプトは JSON を読み、変換結果を標準出力へ返す。

```sh
node scripts/migrate-kamakura-blocks.mjs input.json > result.json
```

| 入力キー | 内容 |
| --- | --- |
| `document`、`sourceBlocks` | 移行元の PageDocument とそのブロック契約。共通部品やスタイルが必要なら `sourceComponents`、`sourceStyles` も渡す |
| `presentation` | 埋め込みとカルーセルが使う移行元の SitePresentation。ブロック名と props が一致する表示だけを採用する |
| `target` | 移行先の下書きから取った `siteId`、`pageId`、`locale`、`revision`、`version` |
| `frameOrigins`、`cmsSchema` | それぞれ移行先に設定した iframe の許可 origin と CMS の定義 |
| `replacements` | 置換するブロックごとの `nodeId` と下表の指定 |

| `kind` | 追加の指定 |
| --- | --- |
| `cms-list`、`cms-detail` | 通常の要素で構成した `body` と既存 CMS 契約の `binding`。旧スロットのスタイルを移す場合は `slotBindings` でスロット名と要素IDを対応付ける |
| `carousel` | なし。既存の表示文書とカルーセルの設定を使う |
| `frame` | `embed` に移行先でも使える公開 URL と表示名を指定する。旧表示にある単一の iframe と一致する場合に変換する |
| `managed-embed` | 移行先で登録した `refId`。必要に応じて `background` と `initialHeight` |

`ready` では `snapshot` と `cmsBindings` が得られる。プレビューと内容を確認したら、移行先の同じ下書きへ `niho-edit save --json` で `snapshot`、続いて `niho-edit apply --ops` の空配列と `--cms-bindings` で binding を保存し、両方そろった文書を公開する。移行元の PageDocument や秘密を含む設定は作業ファイルから公開リポジトリへ移さない。

`blocked` の場合は保存用の文書を出さず、対象の node と理由を返す。省略した置換、読めない旧枠、追加で確認が必要な表示は、対象ページに残す。フォームの URL と配布 token は既存の接続設定で管理する。[ManagedEmbed の保存・公開契約](managed-embed-contract.md)

## 実ページの確認

ローカルの移行元エクスポートでは、旧フォームが3ページに3枠、旧表示枠が7ページに13枠残っていた。旧表示枠のうち、2枠は公開 iframe の設定から変換できた。3枠はホストによる高さ調整が必要で、8枠は読み取り用データに iframe の設定がなかった。地図1枠とカルーセル3枠の変換も確認した。

旧ブロックの契約を取り除く前に、別の公開先で該当ページを確認する。確認する項目は表示、フォーム送信、iframe の高さ調整、予約 iframe、GA4 の pageview。ここでの検証は読み取り用データの変換とローカル描画までで、検証 host での受入は未実施。
