# 編集画面の説明

@niho/web/editor は、人が Studio から構造化ページ文書を編集する React UI です。認証済みホストが渡す EditorAdapter と trusted block registry を使います。CLI 操作、認証、保存先の実装、業務処理を画面に持ち込みません。

## 基本構成

画面はページや素材などのパネル、公開と同じ renderer を使うキャンバス、選択対象を編集する inspector で構成します。機能は接続済み host capability に応じて表示します。host が提供しない機能を、動作するように見える UI として表示しません。

視覚・用語の規則は[編集画面のUI設計](editor-ui-design.md)と[編集画面の用語](editor-terminology.md)を参照してください。保存競合、復元、履歴は[保存と版履歴](save-history-contract.md)、部品の設定は[共通部品](component-contract.md)、block の表示領域は[block slots](block-slot-contract.md)を参照してください。

## 表示領域

キャンバス上の表示領域は host registry が宣言した領域だけを表示します。スタッフが変更できるのは宣言済みの見た目と表示用の文字です。実データの取得、保存、予約、送信等の業務処理は trusted host 側で行います。

## 編集モデル

GUI の文書操作は React 非依存の editor-model を使います。外部 client は安定 node ID を指定し、ホストの version 付き保存 API を使います。詳細は[編集 API](editing-api-contract.md)と[エディターのホスト契約](editor-contract.md)を参照してください。
