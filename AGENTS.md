# niho-web agent contract

- このリポジトリは公開。内部の URL・ID・秘密・他 repo の非公開情報を、コード・docs・Issue・PR のどこにも書かない。
- 報告・PR・Issue は日本語で書く。そのmergeで完了する PR は `Fixes #n`、途中は `Refs #n`。
- **作業は固定の seat worktree だけで行う**: `../niho-web-paneB-1`〜`paneB-3`（この repo の git worktree）。**owner に明示されない限り、新しい worktree・clone を作らない**（アプリが作る `.claude/worktrees/` も含む）。
- seat の取り方: `scripts/seat.sh status` で状態を確認し、clean な topic branch がある seat も再利用できる。`scripts/seat.sh start <topic>` は最新 `origin/main` から `paneB-N/<topic>` を作り、旧 branch ref を残す。未コミット差分のある seat は保護し、同じ seat の同時編集はしない。PR merge 後は `scripts/seat.sh release` で `origin/main` に戻す。`git stash` は禁止。詳細は [Pane 作業フロー](docs/panes/panes-workflow.md)。
- Node は 22 以上。依存は `npm ci`（`npm install` で lock を書き換えない）→ `npm run build` → `npm test`（build と `node --test`）。`studio/` を触ったら `npm run studio:typecheck` も。
- PR は CI とテストが通り、`examples/` のデモか Studio で動作を確かめたら、実装担当が merge してよい（owner 2026-10-25）。Studio Worker の配備（`wrangler deploy --config studio/wrangler.toml`）は owner の依頼があるときだけ。
- 核は、人が Studio の GUI、AI が `niho-edit` で同じ正本を編集・公開し、速く検索に強いサイトを作れること。当面は鎌倉のスタッフ1〜3人を対象に、修正と復元ができる単純な仕組みにする。文書・検証・描画・編集操作の品質を保ち、別ホストへの汎用化や性能対策は必要になった時に行う。鎌倉の保存と配信は段階的に Studio へ集約し、外部 CMS との連携は追加しない。
- 入力はサーバーの境界で1回だけ厳密に検証する。クライアントは応答を1回だけ読み、未知のキーは無視する。別サイトや別プロジェクトへの書き込みを防ぐ project・scope の照合と認可は、層をまたいでも維持する。
- 公開 API・通信形式・型・運用手順を変えた PR では、該当する契約文書だけを更新する。README は利用開始と入口の目次として扱う。機能を撤去した PR では、その機能の文書とテストも削除する。
- 現行の外部ホスト（kamakura-site・Experience）が所有する認証・保存・非公開データ・予約・決済は、そのホストが扱う。
