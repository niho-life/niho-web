import { collectionCss } from "./collection-style.js";

/**
 * LocalizationWorkspace だけの CSS。根は .nw-collection.nw-localization で、ボタン・印・一覧・ダイアログは CMS の画面（collectionCss）を使う。
 * 状態は色だけでなく、印の形（.lw-shape）と言葉でも示す。320px で横にはみ出さない。
 */
const localizationCss = `
.nw-localization{--lw-changed:#8a4b00;--lw-changed-soft:#fdecd6;--lw-mark:#2a4f8f;--lw-mark-soft:#e6edf9;--lw-source-bg:#f9f8f5}
.nw-localization .lw-pill[data-lw-state=untranslated]{background:var(--cw-draft-soft);color:var(--cw-draft)}
.nw-localization .lw-pill[data-lw-state=draft]{background:var(--cw-accent-soft);color:var(--cw-accent)}
.nw-localization .lw-pill[data-lw-state=source-changed]{background:var(--lw-changed-soft);color:var(--lw-changed)}
.nw-localization .lw-pill[data-lw-state=reviewed]{background:var(--cw-ok-soft);color:var(--cw-ok)}
.nw-localization .lw-pill[data-lw-state=excluded]{background:var(--cw-hover);color:var(--cw-muted)}
.nw-localization .lw-pill[data-lw-state=images]{background:var(--cw-sch-soft);color:var(--cw-sch)}
.nw-localization .lw-pill[data-lw-state=pending-source]{background:var(--cw-hover);color:var(--cw-ink);font-weight:600}
.nw-localization .lw-shape{position:relative;display:inline-block;flex:none;width:9px;height:9px;border:1.6px solid currentColor;border-radius:50%}
.nw-localization [data-lw-state=draft]>.lw-shape,.nw-localization .lw-shape[data-lw-state=draft]{background:linear-gradient(90deg,currentColor 50%,transparent 50%)}
.nw-localization [data-lw-state=source-changed]>.lw-shape,.nw-localization .lw-shape[data-lw-state=source-changed]{width:0;height:0;border:0;border-left:5.5px solid transparent;border-right:5.5px solid transparent;border-bottom:10px solid currentColor;border-radius:0}
.nw-localization [data-lw-state=reviewed]>.lw-shape{background:currentColor}
.nw-localization [data-lw-state=reviewed]>.lw-shape::after{content:"";position:absolute;left:2px;top:0;width:2.5px;height:5px;border:solid var(--cw-surface);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.nw-localization [data-lw-state=excluded]>.lw-shape{border-radius:2px;background:linear-gradient(135deg,transparent 42%,currentColor 42%,currentColor 58%,transparent 58%)}
.nw-localization .lw-progress{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 10px;font-size:13px}
.nw-localization .lw-progress progress{width:160px;max-width:100%;height:8px;accent-color:var(--cw-ok)}
.nw-localization .lw-num{font-variant-numeric:tabular-nums;font-weight:650}
.nw-localization .lw-note{margin:0;color:var(--cw-ok);font-size:12.5px;font-weight:600}

.nw-localization .lw-band{display:flex;align-items:flex-start;flex-wrap:wrap;gap:12px 20px;padding:16px 32px;border-bottom:1px solid var(--cw-border);background:var(--cw-ground)}
.nw-localization .lw-band-main{display:grid;gap:6px;flex:1 1 320px;min-width:0}
.nw-localization .lw-band h2{margin:0;font-size:18px;line-height:1.4}
.nw-localization .lw-band-line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:0;font-size:13px;overflow-wrap:anywhere}
.nw-localization .lw-pending{padding:6px 10px;border-radius:8px;background:var(--lw-changed-soft);color:var(--lw-changed)}
.nw-localization .lw-band-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.nw-localization .lw-needs{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--lw-changed-soft);color:var(--lw-changed);font-size:11.5px;font-weight:700}
.nw-localization .cw-nav-count+.lw-needs{margin-left:4px}
.nw-localization .lw-rows-head,.nw-localization .lw-row{grid-template-columns:minmax(0,1fr) 230px 90px 150px}
.nw-localization .lw-row .cw-row-open{padding-left:6px}
.nw-localization .lw-cell-reviewed{font-variant-numeric:tabular-nums}

.nw-localization .lw-item .cw-editor-status{gap:4px 10px}
.nw-localization .lw-item-title{min-width:0;max-width:100%;overflow:hidden;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.nw-localization .lw-item-body{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;flex:1;background:var(--cw-ground)}
.nw-localization .lw-item-body.lw-with-preview{grid-template-columns:minmax(0,1fr) minmax(320px,42%)}
.nw-localization .lw-units{display:grid;gap:14px;min-width:0;padding:20px 28px 72px}
.nw-localization .lw-item-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;color:var(--cw-muted);font-size:12.5px}
.nw-localization .lw-changed{display:grid;gap:12px;padding:14px;border-radius:12px;background:var(--lw-changed-soft)}
.nw-localization .lw-group-title{display:flex;align-items:center;gap:8px;margin:0;color:var(--lw-changed);font-size:14px}
.nw-localization .lw-group-title .lw-shape{width:0;height:0;border:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:11px solid currentColor;border-radius:0}
.nw-localization .lw-changed .cw-hint{color:var(--lw-changed)}
.nw-localization .lw-section{margin:10px 0 0;color:var(--cw-muted);font-size:12px;font-weight:700;letter-spacing:.06em}
.nw-localization .lw-unit{display:grid;gap:10px;min-width:0;padding:16px 18px;border-radius:12px;background:var(--cw-surface);box-shadow:0 0 0 1px var(--cw-border)}
.nw-localization .lw-unit[data-state=review-needed]{box-shadow:0 0 0 1px var(--lw-changed),inset 4px 0 0 var(--lw-changed)}
.nw-localization .lw-unit-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-width:0}
.nw-localization .lw-unit-label{margin:0;min-width:0;font-size:14px;font-weight:700;overflow-wrap:anywhere}
.nw-localization .lw-unit-label .cw-required{margin-left:6px}
.nw-localization .lw-unit-save{margin-left:auto;display:inline-flex;align-items:center;gap:4px}
.nw-localization .lw-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;min-width:0}
.nw-localization .lw-source,.nw-localization .lw-target{display:grid;align-content:start;gap:6px;min-width:0}
.nw-localization .lw-source>.lw-text{display:block;min-height:40px;padding:8px 10px;border-radius:8px;background:var(--lw-source-bg);box-shadow:inset 0 0 0 1px var(--cw-border)}
.nw-localization .lw-col-label{color:var(--cw-muted);font-size:12px;font-weight:650}
.nw-localization .lw-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
.nw-localization .lw-input{display:block;min-width:0;min-height:40px;padding:8px 10px;border:1px solid var(--cw-field-border);border-radius:8px;background:var(--cw-surface);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;cursor:text}
.nw-localization .lw-input:not([data-single-line]){min-height:72px}
.nw-localization .lw-input[aria-invalid=true]{border-color:var(--cw-danger);box-shadow:0 0 0 1px var(--cw-danger)}
.nw-localization .lw-input[aria-readonly=true]{background:var(--cw-ground);cursor:default}
.nw-localization .lw-mark{display:inline-block;margin:0 2px;padding:0 7px;border:1px solid var(--lw-mark);border-radius:6px;background:var(--lw-mark-soft);color:var(--lw-mark);font-size:12px;font-weight:650;line-height:1.6;white-space:nowrap;vertical-align:baseline;user-select:all;cursor:default}
.nw-localization .lw-mark[data-edge=open]{border-right-style:dashed;border-radius:6px 2px 2px 6px}
.nw-localization .lw-mark[data-edge=close]{border-left-style:dashed;border-radius:2px 6px 6px 2px}
.nw-localization .lw-candidate{display:grid;gap:6px;padding:10px;border-radius:8px;background:var(--cw-accent-soft)}
.nw-localization .lw-candidate .cw-button{justify-self:start}
.nw-localization .lw-previous summary{min-height:32px;color:var(--lw-changed);font-size:12.5px;font-weight:650;cursor:pointer}
.nw-localization .lw-previous .lw-text{display:block;padding:6px 10px;border-radius:8px;background:var(--lw-changed-soft)}
.nw-localization .lw-conflict{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 12px;border-radius:8px;background:var(--cw-danger-soft);box-shadow:inset 4px 0 0 var(--cw-danger);font-size:13px}
.nw-localization .lw-conflict p{flex:1 1 240px;margin:0}
.nw-localization .lw-unit-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;justify-content:space-between}
.nw-localization .lw-image{display:block;max-width:100%;overflow:hidden;border-radius:8px;background:var(--cw-hover)}
.nw-localization .lw-image img{display:block;max-width:100%;max-height:220px;margin:0 auto;object-fit:contain}
.nw-localization .lw-image-target{display:grid;gap:8px;min-width:0}
.nw-localization .lw-same{margin:0;padding:12px;border:1px dashed var(--cw-field-border);border-radius:8px;color:var(--cw-muted);font-size:13px}
.nw-localization .lw-file{cursor:pointer}
.nw-localization .lw-file:focus-within{outline:3px solid var(--cw-focus);outline-offset:2px}

.nw-localization .lw-preview{position:sticky;top:calc(var(--niho-sticky-top,0px) + 56px);display:grid;gap:8px;min-width:0;max-height:calc(100vh - var(--niho-sticky-top,0px) - 56px);padding:16px;border-left:1px solid var(--cw-border);background:var(--cw-surface);overflow:auto}
.nw-localization .lw-preview-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.nw-localization .lw-preview h3{margin:0 auto 0 0;font-size:14px}
.nw-localization .lw-preview-page select{width:auto;max-width:100%}
.nw-localization .lw-toggle{display:inline-flex;flex-wrap:wrap;border:1px solid var(--cw-field-border);border-radius:8px;overflow:hidden}
.nw-localization .lw-toggle button{min-height:36px;min-width:44px;padding:0 10px;border:0;background:var(--cw-surface);font-size:12.5px;font-weight:600}
.nw-localization .lw-toggle button+button{border-left:1px solid var(--cw-field-border)}
.nw-localization .lw-toggle button[aria-pressed=true]{background:var(--cw-ink);color:var(--cw-surface)}
.nw-localization .lw-toggle button[aria-pressed=true]::before{content:"✓ "}
.nw-localization .lw-toggle button:focus-visible{outline-offset:-3px}
.nw-localization .lw-preview-note,.nw-localization .lw-preview-status{margin:0;color:var(--cw-muted);font-size:12px}
.nw-localization .lw-frame-wrap{min-width:0;overflow:auto;border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-ground)}
.nw-localization .lw-frame{display:block;width:100%;height:70vh;min-height:420px;margin:0 auto;border:0;background:#fff}
.nw-localization .lw-frame-wrap[data-width="360"] .lw-frame{width:360px;max-width:none}
.nw-localization .lw-frame-wrap[data-width="320"] .lw-frame{width:320px;max-width:none}

.nw-localization .lw-dialog{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto}
.nw-localization .lw-dialog-wide{width:min(640px,100%)}
.nw-localization .lw-dialog h2:focus-visible{outline:none}
.nw-localization .lw-dialog-body{display:grid;gap:12px;min-width:0}
.nw-localization .lw-dialog-lead{margin:0;color:var(--cw-ink)}
.nw-localization .lw-blockers{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.nw-localization .lw-blockers li{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:8px 10px;border-radius:8px;background:var(--cw-danger-soft);font-size:13px}
.nw-localization .lw-blockers li>span{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}
.nw-localization .lw-plan dd{text-align:right}
.nw-localization .lw-history{display:grid;gap:0;margin:0;padding:0;list-style:none}
.nw-localization .lw-history-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;min-height:56px;padding:8px 0;border-bottom:1px solid var(--cw-border)}
.nw-localization .lw-history-row[data-current=true]{background:var(--cw-ok-soft);margin:0 -8px;padding:8px}
.nw-localization .lw-history-text{display:grid;flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.nw-localization .lw-inline-banner{border:0;border-radius:8px}

.nw-localization .lw-settings-body{display:grid;gap:16px;max-width:720px;margin:0 auto;padding:24px 24px 64px}
.nw-localization .lw-settings-body h2{margin:0;font-size:20px}
.nw-localization .lw-settings-body h2:focus-visible{outline:none}
.nw-localization .lw-settings-card{display:grid;gap:10px;padding:18px;border-radius:12px;background:var(--cw-surface);box-shadow:0 0 0 1px var(--cw-border)}
.nw-localization .lw-settings-card h3{margin:0;font-size:14px}
.nw-localization .lw-check{display:flex;align-items:flex-start;gap:10px;min-height:40px;cursor:pointer}
.nw-localization .lw-check input{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--cw-ink)}
.nw-localization .lw-settings-actions{display:flex;gap:8px}

@media (max-width:1099px){
.nw-localization .lw-item-body.lw-with-preview{grid-template-columns:minmax(0,1fr)}
.nw-localization .lw-preview{position:static;max-height:none;border-left:0;border-top:1px solid var(--cw-border)}
}
@media (max-width:899px){
.nw-localization .lw-band{padding:14px 16px}
.nw-localization .lw-units{padding:14px 12px 48px}
.nw-localization .lw-pair{grid-template-columns:minmax(0,1fr)}
.nw-localization .lw-unit{padding:14px 12px}
.nw-localization .lw-input{font-size:16px}
}
@media (max-width:640px){
.nw-localization .lw-row{grid-template-columns:minmax(0,1fr)}
.nw-localization .lw-row .cw-row-meta{padding-left:6px}
.nw-localization .lw-band-actions{width:100%}
.nw-localization .lw-band-actions .cw-button{flex:1 1 auto}
.nw-localization .lw-unit-save{margin-left:0;flex-basis:100%}
.nw-localization .lw-frame{min-height:360px;height:60vh}
.nw-localization .lw-progress progress{width:120px}
.nw-localization .lw-settings-body{padding:16px 16px 48px}
}
`;

/** 翻訳の画面の CSS（CMS の画面の CSS を含む）。inline の <style> を CSP で拒むホストは、これをファイルにして読み込む。 */
export const localizationWorkspaceCss = collectionCss + localizationCss;
