# 共通エディターのホスト接続契約

`PageEditor` は画面、`editor-model` は純粋な文書操作、ホスト adapter は外部との入出力を担います。認証・権限・正本の保存・公開はホストの責任です。

## 責任の境界

- adapter は、対象の Project・Site・page・locale を明示して読み書きします。
- 画面が read-only と表示しても、認可の根拠にはなりません。ホストは各書込で現在の利用者と対象 scope を検証します。
- 別 Project・Site への書込を防ぐ scope 制約は、呼び出し元・adapter・保存先の各境界で維持します。
- 認証 token、service credential、サイトの秘密は文書やブラウザー用の設定に含めません。

## 入力と応答

- 外部からの要求は、サーバーの信頼境界で型と値を一度厳密に検証します。
- クライアントは応答を一度読み取り、必要な既知項目を検証します。未知の項目は無視します。
- 異なる API 層で同じ payload 全体を繰り返し検証したり、既知の応答へ未知の項目が加わっただけで失敗させたりしません。project・site・scope の認可確認は省略しません。

## 保存と競合

ホストが版を管理し、保存時に期待版と正本を原子的に比較します。競合時に画面は編集中の値を保持し、最新内容と比較して利用者が解決できるようにします。画面の read-only 表示や client の検証は、サーバー側の認可・検証の代わりになりません。

## 関連契約

- 型と接続先: `src/editor.tsx` の `EditorAdapter`
- 共通の HTTP 操作と request/response: [Editing API 契約](editing-api-contract.md)
- 版履歴と復元: [保存・履歴契約](save-history-contract.md)
- サイトごとのスタイル操作: [サイト共通スタイル契約](site-styles-contract.md)
