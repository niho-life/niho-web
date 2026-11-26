/** Internal capability used only by the editor after it validates its document snapshots. */
export const editorRendererToken = Object.freeze({});
/** React preserves string props but drops symbol-keyed props during element creation. */
export const editorRendererTokenProp = "__nihoEditorRendererToken" as const;
