# niho-web agent contract

## 方針
- 核は、スタッフが Studio GUI、AI が `niho-edit` CLI から同じ正本を編集・公開できること。現在の対象は鎌倉1サイト、スタッフ1〜3人。
- 必要が分かる前の汎用化、互換層、重複検証は増やさず、変更は目的に必要な範囲へ絞る。
- この公開リポジトリに秘密、非公開の URL・ID、利用側の非公開データを書かない。

## 境界と検証
- ホストが認証・認可・保存・公開を担い、niho-web は文書形式・編集操作・描画を担う。
- API 入力はサーバーの境界で一度厳密に検証する。応答はクライアントで一度読み取り、未知の項目は無視する。
- 他のサイトやプロジェクトへ書き込ませないための project・site・scope 制約は、どの層でも維持する。

## 文書
- 公開 API・通信形式・型・運用手順が変わる場合に、該当する契約文書を同じ PR で更新する。
- README は利用開始・入口一覧・開発コマンド・文書へのリンクを示す。機能 PR ごとに更新しない。
- 機能や経路を削除するときは、対応する説明も同じ PR で削除する。

## 作業と検証
- 作業は固定 seat worktree（`../niho-web-paneB-1`〜`../niho-web-paneB-3`）で行う。owner の明示がない限り、新しい worktree・clone は作らない。既存差分は保護し、`git stash` は使わない。
- Node.js 22 以上。`npm ci`、`npm run build`、`npm test` を使う。`studio/` を変更したら `npm run studio:typecheck` も実行する。
- PR は CI と必要なテストを通し、該当するデモか Studio で動作確認してから merge する。
- Studio Worker の配備（`wrangler deploy --config studio/wrangler.toml`）は owner が依頼したときだけ行う。

利用側（kamakura-site・Experience）の認証、保存先、非公開データ、予約・決済処理は利用側の責務。
