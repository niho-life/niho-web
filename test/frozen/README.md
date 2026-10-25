# サイト全体のビジュアル編集に関する旧接続テスト

2026-10-22の凍結前に、公開サイトとのプレビュー・署名付きproxy接続を確認していた資料。現在のStudioは認証・参加資格の確認後に編集を拒否するため、これらを標準テストやサイト変更の受入条件へ含めない。

現行の拒否動作は `test/studio-worker-integrations.test.mjs`、独立した文書・契約の検証は標準テストで維持する。将来の再接続では、新たな設計・受入を行う。

2026-10-25: Kamakura は読み取りだけ再接続した（niho-life/kamakura-site#84）。上流接続のテストは `test/kamakura-editor-bridge.test.mjs` として標準テストへ戻した。Experience の旧接続テストはここに残す。
