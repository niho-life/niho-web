# niho-web agent contract

- このリポジトリは公開。内部の URL・ID・秘密・他 repo の非公開情報を、コード・docs・Issue・PR のどこにも書かない。
- 報告・PR・Issue は日本語で書く。そのmergeで完了する PR は Fixes #n、途中は Refs #n。
- 作業は固定の seat worktree だけで行う: ../niho-web-paneB-1〜paneB-3。owner に明示されない限り、新しい worktree・clone を作らない。seat 運用は scripts/seat.sh と docs/panes/panes-workflow.md に従い、git stash は使わない。
- Node は 22 以上。依存は npm ci（npm install で lock を書き換えない）→ npm run build → npm test。studio/ を触ったら npm run studio:typecheck も実行する。
- PR は CI とテストが通り、examples のデモか Studio で動作を確かめたら、実装担当が merge してよい（owner 2026-10-25）。Studio Worker の配備は owner の依頼があるときだけ。
- 利用側（kamakura-site・Experience）の認証・保存・非公開データ・予約や決済の処理はホストの責務で、niho-web に入れない。

## 製品方針

- owner 方針 #474 を正とする。人は Studio GUI、AI は niho-edit で同じ正本を編集・公開する。まず鎌倉の1サイト、スタッフ1〜3人向けに簡単さと SEO を優先し、必要になる前に汎用化・過剰な堅牢化をしない。
- 鎌倉のページ・CMS・素材・翻訳は段階的に niho-web へ移す。移行完了までは現行の保存・公開経路へ機能を追加せず、不具合修正と本文更新に限る。外部 CMS へ連携しない。
- 外部入力はサーバー側の信頼境界で一度だけ厳密に検証する。クライアントは応答を一度だけ読み、未知のキーを無視する。Project・Site・resource scope の制約は各層で維持し、別サイトや別 Project への書込みを拒否する。

## 文書の更新

- 公開 API・通信形式・型・運用手順を変えるときだけ、該当する契約文書や runbook を更新する。
- README は利用開始と各 entry point、開発コマンド、文書への入口を示す目次として保つ。通常の機能 PR では README を更新しない。
- 撤去する機能に専用の説明文書があれば、同じ PR で削除する。
