# ADR-0001: プラットフォーム CMS の正本と公開単位

- 日付: 2026-11-26
- 状態: Accepted。owner が 2026-11-26 に確認済み。
- 関連: #371, #372, #373, #374, #375, #378, #379, #380, #335

## 背景

現在の `CollectionWorkspace` と `cms.*` v1 は、コレクション定義・項目・下書き・公開の正本をホストに置く契約である。Studio は鎌倉向けに画面と BFF を提供するが、CMS の保存と公開は鎌倉サイトが担う。Studio-native site にはページの正本はあるが CMS はない。

編集基盤 v2 の Issue #335 では Studio-native site の CMS を当時の実装範囲から外した。#371 はそれを後続段階として再検討する提案であり、この ADR は目標アーキテクチャを示す。実装・受入前に現行契約を変更したことにはしない。

## 決定

### 1. CMS の所有形態

CMS は次の二形態を持つ。

| 形態 | 正本 | 公開を担うもの |
| --- | --- | --- |
| Studio 管理 CMS | Studio が定義、下書き、版、公開 release を所有する | Studio-native site はサイト manifest を公開し、外部ホストは CMS release を取り込んで配備する |
| 外部ホスト CMS | 接続先ホストが引き続き定義、項目、下書き、公開を所有する | 接続先ホスト |

1つのサイトの同じ CMS に対して、Studio とホストが同時に書込み正本になる状態は作らない。現行の外部ホスト CMS は明示的な移行が終わるまでそのまま使う。移行は既存データと素材を棚卸しし、Studio へ下書きとして取り込み、件数・安定 ID・値・参照を照合した後、書込みを止めて最終差分を取り込む。Studio を唯一の書込み先に切り替え、ホストが公開 snapshot を使えることを確認してから再開する。二重書込みや「どちらが新しいか」を利用時に判断する期間は設けない。

Studio が正本になった後の通常の切戻しは、同じ正本から作った以前の不変 release への rollback とする。書込み先自体をホストへ戻す場合は、Studio 側の変更をすべて逆向きに移送し、再度一方だけを正本にする別の移行として扱う。

### 2. CMS に入れるデータ

CMS は公開を前提に編集する記事、告知、紹介文、分類、公開画像などの編集コンテンツを持つ。予約・決済・会員、個人情報、フォーム回答、在庫・予約可能性、権限判定などの非公開データや実行時判断は、引き続き NIHO API などのホストが所有する。業務上の値を公開用文章として複製し、CMS をその値の権威ある情報源として扱わない。

CMS snapshot に認証情報、Access token、署名鍵、プレビュー専用 URL、個人データを含めない。素材は stable ID と公開用 manifest で参照し、非公開の upload や preview capability を公開データへ混ぜない。

### 3. 公開単位

**Studio-native site** はサイト全体の公開 manifest を単位にする。manifest は、公開するページ・テンプレート・presentation、CMS の公開 snapshot、locale と locale route、公開素材の参照、route table を含み、すべての依存を不変の revision または content hash へ固定する。検証済み manifest を保存した後、D1 transaction で current manifest pointer を一度に切り替える。公開サイトはその pointer が指す manifest だけを読むため、ページと CMS の異なる公開世代を混在させない。rollback は以前の manifest pointer へ戻す。

**外部ホスト** は CMS 全体の release を公開単位にする。release は定義の版、公開対象項目の版、locale、CMS route 情報、公開素材の固定参照を含む完全な不変 snapshot とし、同一内容に対する ETag は content hash から作る。ホストは release の契約版と hash を検証し、snapshot を自身の renderer 用成果物へ取り込み、配備後に成果物の識別子を付けて ack する。固定ページやテンプレートとの同時 transaction は保証しない。

ack は「そのホストが指定 release を含む成果物を配備した」という記録であり、編集上の公開承認ではない。Studio 側の公開状態とホストへの delivery state は別々に管理し、送信済みを反映済みと表示しない。最初は全体 snapshot 方式とし、差分配信、任意 URL への汎用 webhook、複数ホスト向けの自由な通知先設定は運用実績を得るまで追加しない。

### 4. Tenant と認可

Studio GUI と `niho-edit` CLI の各要求は、認証後に現在の membership と対象 Project/Site の所属をサーバー側で照合する。client が送る site、collection、item、release、cursor、version は対象を選ぶ値であり、認可根拠にはしない。collection/item、preview、snapshot、operation status、delivery cursor、ack は親の Site に結び付けて検索し、別 Site の ID を指定した要求は存在を漏らさず拒否する。membership の削除・変更は次の要求から有効にする。

既存の `owner` / `editor` role を使い、権限は初期版で次のようにする。

| 操作 | owner | editor |
| --- | --- | --- |
| CMS・定義・公開状態の読取と preview | 可 | 可 |
| 項目の作成・編集・削除・予約 | 可 | 可 |
| 公開・rollback | 可 | 可 |
| 定義変更の plan | 可 | 可 |
| 定義変更の apply、membership・delivery credential の管理 | 可 | 不可 |

これは Studio の既存 editor が CMS の公開操作を行える意味を保ち、全項目へ影響し得る定義変更だけを owner に限定する。CLI grant は発行時に Site と scope を固定し、期限・失効を持たせる。外部ホストの delivery credential は人の membership と別にし、1 Site の snapshot read と ack にだけ使えるようにする。署名対象には時刻・request path・body hash・Site を含め、再送可能時間を制限する。

### 5. 保存、公開、通知の整合性

D1 transaction、オブジェクト保存、外部通知は原子的にできない。そのため、不変 blob を先に書き、内容 hash を検証してから、D1 transaction で pointer・operation receipt/idempotency key・audit record・outbox event を一緒に確定する。transaction は期待する現行 revision と Site の所属を再確認する。CMS API v1 の意味は変えず、新しい定義・release 操作は版交渉を持つ v2 契約に分ける。未対応の定義版を読む旧 client は書込みを fail-closed にする。

通知 worker は outbox を少なくとも一回配信し、重複を前提にする。受信側は site、release、hash が同じ event と ack を冪等に処理する。外部ホストは自分の renderer 契約版を確認してから build し、検証と配備に失敗した場合は現在の成果物を維持して失敗 ack を返す。Studio の release pointer は送信や配備失敗を理由に勝手に戻さない。

| 失敗点 | 状態と復旧 |
| --- | --- |
| blob の書込み・検証に失敗 | D1 pointer、受領記録、audit、outbox を変更しない。operation を再試行する。 |
| blob 保存後に D1 transaction が失敗 | 旧 pointer を維持する。未参照 blob は安全期間後にのみ orphan として回収する。 |
| D1 transaction 成功後に通知が失敗 | release は確定済み。outbox を再試行し、同じ event ID を使う。 |
| snapshot の取得・build・配備が失敗 | 前回の成果物を維持し delivery state を失敗にする。同一 release を再試行できる。 |
| ack の送信が重複・遅延 | Site/release/hash が一致する同一 ack は冪等に受け付け、別 hash や別 Site は拒否する。 |
| 予約実行時に前提が変化・衝突 | 予約時に固定した定義・項目・locale・素材の版を使う。route 等の安全条件を再検証し、満たさなければ公開せず失敗として再計画を求める。 |

current pointer が指す blob と履歴・予約・outbox が必要とする blob は削除しない。バックアップから復元するときは D1 と参照先 blob の両方を戻し、hash と参照の存在を確かめてから pointer を有効にする。定期バックアップ、保持期間、復元試験と orphan 回収の運用詳細は #374 の実装受入で決める。

### 6. 契約文書と互換性

この ADR だけでは `docs/collection-contract.md` や README の「正本はホスト」という現行契約を書き換えない。#373 以降のコード、適合テスト、Studio-native の受入、外部 snapshot/ack の受入が揃う段階ごとに、実際に提供される範囲に合わせて契約文書と README を同じ PR で更新する。v1 の `cms.*`、外部ホストが正本である既存接続、既存項目の読み書きは移行完了まで維持する。

## 次の Issue への引継ぎ

- #373: v2 discovery、定義 revision / stable `fieldId`、状態分離、schema plan/apply、immutable release、予約と fail-closed。
- #374: Studio 保存、Site-scoped operation receipt / audit / outbox、snapshot blob、ack、backup / restore、Studio-native の manifest と一覧・詳細描画。
- #375 / #378 / #379: route collision と locale route、公開素材 manifest と preview 分離。
- #380: ETag 付き snapshot 取得、対象を限定した通知、host build artifact ack、delivery client。
- 鎌倉の実データ移行は kamakura-site #444 の棚卸し・取込み・影の照合・切替・旧書込み撤去で行う。

## Owner 承認

owner は 2026-11-26 に次の 3 点を承認した。

- Studio-native site を将来の CMS 正本に含める。
- `editor` は公開でき、定義変更の apply は `owner` に限定する。
- 外部ホストとの公開単位は CMS 全体 snapshot とし、固定ページとの原子性は保証しない。

この決定に基づき #373 の契約実装へ進む。
