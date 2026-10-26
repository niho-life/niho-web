# niho-web agent contract

- このリポジトリは公開。内部の URL・ID・秘密・他 repo の非公開情報を、コード・docs・Issue・PR のどこにも書かない。
- 報告・PR・Issue は日本語で書く。そのmergeで完了する PR は `Fixes #n`、途中は `Refs #n`。
- **作業は固定の seat worktree だけで行う**: `../niho-web-paneB-1`〜`paneB-3`（この repo の git worktree）。**owner に明示されない限り、新しい worktree・clone を作らない**（アプリが作る `.claude/worktrees/` も含む）。空いている seat が無ければ owner に聞く。
- seat の取り方: 空いている seat（detached の origin/main で `git status` が空）に入り、`scripts/seat.sh start <topic>` で `paneB-N/<topic>` を切る。PR が merge されたら `scripts/seat.sh release` で戻す。他の seat に触らない。`git stash` は禁止。
- Node は 22 以上。依存は `npm ci`（`npm install` で lock を書き換えない）→ `npm run build` → `npm test`（build と `node --test`）。`studio/` を触ったら `npm run studio:typecheck` も。
- PR は CI とテストが通り、`examples/` のデモか Studio で動作を確かめたら、実装担当が merge してよい（owner 2026-10-25）。Studio Worker の配備（`wrangler deploy --config studio/wrangler.toml`）は owner の依頼があるときだけ。
- 契約文書（`docs/*.md`）と README の入口表は、同じ PR で更新する。
- 利用側（kamakura-site・Experience）の認証・保存・非公開データ・予約や決済の処理はホストの責務で、niho-web に入れない。
