# niho-web agent contract

- このリポジトリは公開。内部の URL・ID・秘密・他 repo の非公開情報を、コード・docs・Issue・PR のどこにも書かない。
- 報告・PR・Issue は日本語で書く。そのmergeで完了する PR は `Fixes #n`、途中は `Refs #n`。
- **作業は固定の seat worktree だけで行う**: `../niho-web-paneB-1`〜`paneB-3`（この repo の git worktree）。**owner に明示されない限り、新しい worktree・clone を作らない**（アプリが作る `.claude/worktrees/` も含む）。
- seat の取り方: `scripts/seat.sh status` で状態を確認し、clean な topic branch がある seat も再利用できる。`scripts/seat.sh start <topic>` は最新 `origin/main` から `paneB-N/<topic>` を作り、旧 branch ref を残す。未コミット差分のある seat は保護し、同じ seat の同時編集はしない。PR merge 後は `scripts/seat.sh release` で `origin/main` に戻す。`git stash` は禁止。詳細は [Pane 作業フロー](docs/panes/panes-workflow.md)。
- Node は 22 以上。依存は `npm ci`（`npm install` で lock を書き換えない）→ `npm run build` → `npm test`（build と `node --test`）。`studio/` を触ったら `npm run studio:typecheck` も。
- PR は CI とテストが通り、`examples/` のデモか Studio で動作を確かめたら、実装担当が merge してよい（owner 2026-10-25）。Studio Worker の配備（`wrangler deploy --config studio/wrangler.toml`）は owner の依頼があるときだけ。
- 契約文書（`docs/*.md`）と README の入口表は、同じ PR で更新する。
- 利用側（kamakura-site・Experience）の認証・保存・非公開データ・予約や決済の処理はホストの責務で、niho-web に入れない。
