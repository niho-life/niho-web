# エディターのホスト契約

この文書は、React UI が認証済みホストと接続する境界だけを定めます。画面の概要は[編集画面の説明](editor-ui-contract.md)、HTTP の GUI / CLI 共通 wire 契約は[共通編集 API 契約](editing-api-contract.md)を参照してください。

## 責務の境界

PageEditor はホストから EditorAdapter を受け取るクライアントです。認証、認可、Project / Site scope、永続化、版比較、監査、公開、復元、外部データへの接続はホストが所有します。画面は secret や業務データへの直接アクセスを持ちません。

EditorAdapter は GUI 内の境界であり、CLI と GUI の共通 wire 契約ではありません。共通操作、入力・結果 schema、権限、安定 error code は editing-api-contract.md を正本にします。niho-edit と GUI はホストの同じ操作を呼びます。

## Adapter と capability

PageEditor に渡す必須メソッドと任意 capability の型は src/editor-types.ts の EditorAdapter が正本です。接続していない任意機能は UI に有効な入口として表示しません。site name による機能分岐を増やさず、登録済み capability と trusted registry で動作を決めます。

ホストは EditorAdapter の全メソッドを実装する必要はありません。必須の listSites、listPages、readDocument、saveDraft、prepareRelease、release に、素材、翻訳、共通部品、CMS preview、site styles、page management、history 等の必要な capability を追加します。個別 capability のデータ形式と保存規則は、[素材契約](asset-contract.md)、[翻訳契約](localization-contract.md)、[共通部品契約](component-contract.md)、[ページ契約](page-contract.md)、[保存と履歴](save-history-contract.md)を参照してください。

## 入力・scope・版

外部入力はホストの信頼境界で厳密に検証します。HTTP 応答は client で一度だけ読み、未知のキーは無視します。Project / Site / resource scope はすべての書込み経路で再確認し、client の選択値だけを認可根拠にしません。

save は expectedVersion を使って原子的に比較します。古い版の保存は conflict とし、UI は手元の編集を保持します。自動上書き・自動 merge は行いません。operation ID の再送と操作単位保存の wire 契約は[共通編集 API 契約](editing-api-contract.md)を、保存・復元・競合の画面挙動は[保存と版履歴の契約](save-history-contract.md)を参照してください。

## 操作単位の保存

任意 capability の applyOperations を実装した host は未送信の文書操作を pages.apply へ送り、同じ operation ID・入力を使って再送します。競合時は正本と未送信操作を分けて保持し、クライアントだけで古い内容を上書きしません。wire schema・rebase 条件・error code は[共通編集 API 契約](editing-api-contract.md#操作カタログ)、画面での復旧は[保存と版履歴の契約](save-history-contract.md)を正とします。

## サイトスタイル

サイト共通 style の所有権、version、ページ上書き、削除時の参照切り離しは[サイト共通スタイル契約](site-styles-contract.md)を正とします。EditorAdapter は host が提供する capability の範囲で画面へ接続し、ページや component のデータへサイト設定を複製しません。

## 表示と信頼済みコード

PageDocument は検証済みデータであり、実行コードを含みません。描画する block、component とその設定 UI は trusted host が登録します。設定 UI が文書へ書けるのは、block contract に宣言された公開値だけです。表示領域の詳細は[block slots 契約](block-slot-contract.md)を参照してください。
