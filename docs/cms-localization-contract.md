# CMS 項目の多言語契約

`@niho/web/cms-v2` は CMS v2 の項目を翻訳する共通 core を提供します。認可、翻訳provider、永続化、revision採番、公開snapshotの配信はホストの責務です。固定ページの翻訳と同じく `src/localization.ts` の AUTO/MANUAL 保護規則を使い、CMS の collection/item/field identity を足します。

## Identity と単位

項目の identity は `siteId`、`collectionId`、`itemId`、`sourceLocale`、`targetLocale` です。各翻訳単位はこの identity に不変の `fieldId` を加えます。表示名や変更可能な `key` は identity に使いません。`cmsLocalizationItemKey(collectionId, itemId)` は workspace と `niho-edit` で共有する item key を作り、field IDをbase64urlで符号化した `cms.field.<encodedFieldId>` を操作単位IDに使います。CMSが許可するfield ID全体を共通coreの単位ID制約内で衝突なく扱えます。locale は identity に明示し、`ja-JP` / `en-US` などの表記を保持します。現在の共通 translation core が扱う言語 family は日本語と英語です。generic localization core 内の page/site scope は派生IDで分離し、CMS の正本 identity は overlay に保持します。

`collectCmsLocalizationUnits(schema, sourceItem, targetLocale)` は現在の schema と source revision を検証し、`text`、`longText`、`url`、`slug` の値を翻訳単位にします。空値と非テキスト値はそのまま残ります。`richText` は安全な parser をホストから受け取ったときだけ単位にします。parser は翻訳用の構造と無害化済み原文 HTML を返します。fingerprint は構造化した文章、原文 HTML、無害化済みHTMLを含みます。serializer は無害化済み原文 HTML を受け取るため、リンク先など翻訳対象外の属性を保ちながら再度 sanitizer を通せます。parser/serializer は許可タグと属性をホストで担保します。画像、参照、選択肢、日時、gallery等は自動翻訳へ渡しません。

各単位の `sourceFingerprint` は identity、schema revision、原文を結び付けます。原文・定義が変わった古い結果は適用されません。ホストは CMS の翻訳項目画面と `niho-edit localization-*` の双方で、同じ `itemKey`、fieldId由来の `unitId`、locale pair、revision付きoverlay APIを使います。

## Overlay と翻訳

`createCmsLocalizationOverlay` / `parseCmsLocalizationOverlay` は site、項目、locale pair、overlay version を固定します。`editCmsLocalizedValue` は期待 version による CAS 用入力を受け取り、人が編集した値を MANUAL として保存します。`applyAutomaticCmsTranslationResult` は provider の結果を現在の source fingerprint と照合し、MANUAL の訳を置き換えず、自動訳を候補に保存します。URL、メール、数値などの保護規則と rich-text の構造検査は共通 core が適用します。

`cmsLocalizationStatus` は各 field の missing / draft / review-needed / reviewed 状態を返します。安全な parser が渡されていない rich-text field は missing と issue の両方に数え、項目を complete と誤認しません。翻訳の対象外フィールドは状態集計に入りません。自動翻訳 provider、actor、CAS保存、操作重複排除はホストが実装します。

## Target locale 項目

`materializeCmsLocalizedItem` は source revision から target locale の新しい `CmsItemRevision` を組み立て、現在の schema でもう一度値を検証します。ホストが revision ID を渡します。`fallback: "source"` は未訳 field の原文を残し、不足 field ID を返します。`fallback: "omit"` は翻訳可能な field が空または不足した項目を公開候補から除外します。この値は実行時にも厳密に検証し、未知の方針は拒否します。どちらの方針で snapshot を作るかは Site の公開ポリシーに固定してください。

この関数は immutable revision の材料を作るだけです。source/target locale の一覧管理、翻訳保存、previewの分離、locale別の完全な公開snapshot、不変配信と renderer acknowledgement はホストが行い、[CMS v2契約](cms-v2-contract.md) および [公開素材契約](asset-contract.md) と組み合わせます。Studio の外部ホストへの取得と配備結果は [CMS 配信契約](cms-delivery-contract.md) に従います。翻訳済み項目だけを CMS v1 の更新APIに書き戻す使い方はしません。

## ホスト接続チェック

- Studio の翻訳 workspace と `niho-edit localization-*` が同じ collection/item/field ID と locale pair を読書きする。
- 原文 revision が変わった後の古い AUTO 結果を拒否し、MANUAL 値を候補で保護する。
- rich text を使う場合、ホスト sanitizer を通す parser と serializer の両方を渡す。
- locale ごとの target revision と公開snapshotを不変に保存し、previewは公開配信から隔離する。
- fallbackの選択、404/route、asset、ETag、acknowledgementをホスト契約と実環境で確かめる。
