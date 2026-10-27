import { collectionCss } from "./collection-style.js";

/**
 * LocalizationWorkspace だけの CSS。色は ./ui-tokens.ts のトークン（--nw-*）だけを使う（#159）。根は .nw-collection.nw-localization で、ボタン・印・一覧・ダイアログは CMS の画面（collectionCss）を使う。
 * 状態は色だけでなく、印の形（.lw-shape）と言葉でも示す。320px で横にはみ出さない。
 */
const localizationCss = `
.nw-localization{max-width:100%}
.nw-localization .lw-pill[data-lw-state=untranslated]{background:var(--nw-surface-2);color:var(--nw-text-sub)}
.nw-localization .lw-pill[data-lw-state=draft]{background:var(--nw-accent-soft);color:var(--nw-accent-strong)}
.nw-localization .lw-pill[data-lw-state=source-changed]{background:var(--nw-warning-soft);color:var(--nw-warning)}
.nw-localization .lw-pill[data-lw-state=reviewed]{background:var(--nw-surface-2);color:var(--nw-text)}
.nw-localization .lw-pill[data-lw-state=excluded]{background:var(--nw-hover);color:var(--nw-text-sub)}
.nw-localization .lw-pill[data-lw-state=images]{background:var(--nw-warning-soft);color:var(--nw-warning)}
.nw-localization .lw-pill[data-lw-state=pending-source]{background:var(--nw-hover);color:var(--nw-text);font-weight:600}
.nw-localization .lw-shape{position:relative;display:inline-block;flex:none;width:9px;height:9px;border:1.6px solid currentColor;border-radius:50%}
.nw-localization [data-lw-state=draft]>.lw-shape,.nw-localization .lw-shape[data-lw-state=draft]{background:linear-gradient(90deg,currentColor 50%,transparent 50%)}
.nw-localization [data-lw-state=source-changed]>.lw-shape,.nw-localization .lw-shape[data-lw-state=source-changed]{width:0;height:0;border:0;border-left:5.5px solid transparent;border-right:5.5px solid transparent;border-bottom:10px solid currentColor;border-radius:0}
.nw-localization [data-lw-state=reviewed]>.lw-shape{background:currentColor}
.nw-localization [data-lw-state=reviewed]>.lw-shape::after{content:"";position:absolute;left:2px;top:0;width:2.5px;height:5px;border:solid var(--nw-bg);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.nw-localization [data-lw-state=excluded]>.lw-shape{border-radius:var(--nw-radius-sm);background:linear-gradient(135deg,transparent 42%,currentColor 42%,currentColor 58%,transparent 58%)}
.nw-localization .lw-progress{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 10px;font-size:13px}
.nw-localization .lw-progress progress{width:160px;max-width:100%;height:8px;accent-color:var(--nw-accent)}
.nw-localization .lw-num{font-variant-numeric:tabular-nums;font-weight:650}
.nw-localization .lw-note{margin:0;color:var(--nw-text-sub);font-size:12.5px;font-weight:600}

.nw-localization .lw-band{display:flex;align-items:flex-start;flex-wrap:wrap;gap:12px 20px;padding:16px 32px;border-bottom:1px solid var(--nw-border);background:var(--nw-surface)}
.nw-localization .lw-band-main{display:grid;gap:6px;flex:1 1 320px;min-width:0}
.nw-localization .lw-band h2{margin:0;font-size:18px;line-height:1.4}
.nw-localization .lw-band-line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:0;font-size:13px;overflow-wrap:anywhere}
.nw-localization .lw-pending{padding:6px 10px;border-radius:var(--nw-radius-lg);background:var(--nw-warning-soft);color:var(--nw-warning)}
.nw-localization .lw-band-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.nw-localization .lw-needs{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:var(--nw-radius-pill);background:var(--nw-warning-soft);color:var(--nw-warning);font-size:11.5px;font-weight:700}
.nw-localization .cw-nav-count+.lw-needs{margin-left:4px}
.nw-localization .lw-rows-head,.nw-localization .lw-row{grid-template-columns:minmax(0,1fr) 230px 90px 150px}
.nw-localization .lw-row .cw-row-open{padding-left:6px}
.nw-localization .lw-edit-link{text-decoration:none}
.nw-localization .lw-included-parts{font-size:11.5px}
.nw-localization .lw-cell-reviewed{font-variant-numeric:tabular-nums}
.nw-localization .lw-source-link{width:max-content;max-width:100%;margin-top:3px;color:var(--nw-text);font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:3px}
.nw-localization .lw-source-link:hover{color:var(--nw-accent-strong)}
.nw-localization .lw-excluded{margin-top:16px;border-top:1px solid var(--nw-border)}
.nw-localization .lw-excluded>summary{min-height:44px;padding:12px 6px;color:var(--nw-text-sub);font-size:13px;font-weight:650;cursor:pointer}
.nw-localization .lw-excluded>summary span{font-variant-numeric:tabular-nums;font-weight:500}
.nw-localization .lw-excluded>summary:hover{color:var(--nw-text)}
.nw-localization .lw-excluded>summary:focus-visible{outline:2px solid var(--nw-focus);outline-offset:-2px}
.nw-localization .lw-excluded-reason{margin-top:12px}
.nw-localization .lw-excluded-reason h3{display:flex;align-items:baseline;gap:8px;margin:0;padding:10px 6px;color:var(--nw-text-sub);font-size:13px;font-weight:650}
.nw-localization .lw-excluded-reason h3 span{font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}

.nw-localization .lw-item .cw-editor-status{gap:4px 10px}
.nw-localization .lw-item-title{min-width:0;max-width:100%;overflow:hidden;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.nw-localization .lw-item-body{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;flex:1;background:var(--nw-surface)}
.nw-localization .lw-item-body.lw-with-preview{grid-template-columns:minmax(0,1fr) minmax(320px,42%)}
.nw-localization .lw-units{display:grid;gap:14px;min-width:0;padding:20px 28px 72px}
.nw-localization .lw-item-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;color:var(--nw-text-sub);font-size:12.5px}
.nw-localization .lw-related{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:-3px 0 2px}
.nw-localization .lw-related-label{margin-right:3px;color:var(--nw-text-sub);font-size:12px;font-weight:650}
.nw-localization .lw-related-link{display:inline-flex;align-items:center;gap:8px;min-height:32px;padding:5px 10px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-pill);background:var(--nw-surface);color:var(--nw-text);font:inherit;font-size:12px;font-weight:650;text-decoration:none;cursor:pointer}
.nw-localization .lw-related-link:hover{border-color:var(--nw-accent);color:var(--nw-accent-strong)}
.nw-localization .lw-related-link:focus-visible{outline:2px solid var(--nw-focus);outline-offset:2px}
.nw-localization .lw-related-link:disabled{opacity:.55;cursor:wait}
.nw-localization .lw-changed{display:grid;gap:12px;padding:14px;border-radius:var(--nw-radius-lg);background:var(--nw-warning-soft)}
.nw-localization .lw-group-title{display:flex;align-items:center;gap:8px;margin:0;color:var(--nw-warning);font-size:14px}
.nw-localization .lw-group-title .lw-shape{width:0;height:0;border:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:11px solid currentColor;border-radius:0}
.nw-localization .lw-changed .cw-hint{color:var(--nw-warning)}
.nw-localization .lw-section{margin:10px 0 0;color:var(--nw-text-sub);font-size:var(--nw-font-size-label);font-weight:700}
.nw-localization .lw-unit{display:grid;gap:10px;min-width:0;padding:16px 18px;border-radius:var(--nw-radius-lg);background:var(--nw-bg);box-shadow:0 0 0 1px var(--nw-border)}
.nw-localization .lw-unit[data-state=review-needed]{box-shadow:0 0 0 1px var(--nw-warning),inset 4px 0 0 var(--nw-warning)}
.nw-localization .lw-unit-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-width:0}
.nw-localization .lw-unit-label{margin:0;min-width:0;font-size:14px;font-weight:700;overflow-wrap:anywhere}
.nw-localization .lw-unit-label .cw-required{margin-left:6px}
.nw-localization .lw-unit-save{margin-left:auto;display:inline-flex;align-items:center;gap:4px}
.nw-localization .lw-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;min-width:0}
.nw-localization .lw-source,.nw-localization .lw-target{display:grid;align-content:start;gap:6px;min-width:0}
.nw-localization .lw-source>.lw-text{display:block;min-height:40px;padding:8px 10px;border-radius:var(--nw-radius-lg);background:var(--nw-surface);box-shadow:inset 0 0 0 1px var(--nw-border)}
.nw-localization .lw-col-label{color:var(--nw-text-sub);font-size:12px;font-weight:650}
.nw-localization .lw-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
.nw-localization .lw-input{display:block;min-width:0;min-height:40px;padding:8px 10px;border:1px solid var(--nw-border);border-radius:var(--nw-radius);background:var(--nw-surface-2);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;cursor:text}
.nw-localization .lw-input:not([data-single-line]){min-height:72px}
.nw-localization .lw-input[aria-invalid=true]{border-color:var(--nw-danger);box-shadow:0 0 0 1px var(--nw-danger)}
.nw-localization .lw-input[aria-readonly=true]{background:var(--nw-surface);cursor:default}
.nw-localization .lw-mark{display:inline-block;margin:0 2px;padding:0 7px;border:1px solid var(--nw-accent-strong);border-radius:var(--nw-radius);background:var(--nw-accent-soft);color:var(--nw-accent-strong);font-size:12px;font-weight:650;line-height:1.6;white-space:nowrap;vertical-align:baseline;user-select:all;cursor:default}
.nw-localization .lw-mark[data-edge=open]{border-right-style:dashed;border-radius:6px 2px 2px 6px}
.nw-localization .lw-mark[data-edge=close]{border-left-style:dashed;border-radius:2px 6px 6px 2px}
.nw-localization .lw-candidate{display:grid;gap:6px;padding:10px;border-radius:var(--nw-radius-lg);background:var(--nw-accent-soft)}
.nw-localization .lw-candidate .cw-button{justify-self:start}
.nw-localization .lw-previous summary{min-height:32px;color:var(--nw-warning);font-size:12.5px;font-weight:650;cursor:pointer}
.nw-localization .lw-previous .lw-text{display:block;padding:6px 10px;border-radius:var(--nw-radius-lg);background:var(--nw-warning-soft)}
.nw-localization .lw-conflict{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 12px;border-radius:var(--nw-radius-lg);background:var(--nw-danger-soft);box-shadow:inset 4px 0 0 var(--nw-danger);font-size:13px}
.nw-localization .lw-conflict p{flex:1 1 240px;margin:0}
.nw-localization .lw-unit-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;justify-content:space-between}
.nw-localization .lw-image{display:block;max-width:100%;overflow:hidden;border-radius:var(--nw-radius-lg);background:var(--nw-hover)}
.nw-localization .lw-image img{display:block;max-width:100%;max-height:220px;margin:0 auto;object-fit:contain}
.nw-localization .lw-image-target{display:grid;gap:8px;min-width:0}
.nw-localization .lw-same{margin:0;padding:12px;border:1px dashed var(--nw-border-strong);border-radius:var(--nw-radius-lg);color:var(--nw-text-sub);font-size:13px}
.nw-localization .lw-file{cursor:pointer}
.nw-localization .lw-file:focus-within{outline:2px solid var(--nw-focus);outline-offset:2px}

.nw-localization .lw-preview{position:sticky;top:calc(var(--niho-sticky-top,0px) + 56px);display:grid;gap:8px;min-width:0;max-height:calc(100vh - var(--niho-sticky-top,0px) - 56px);padding:16px;border-left:1px solid var(--nw-border);background:var(--nw-bg);overflow:auto}
.nw-localization .lw-preview-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.nw-localization .lw-preview h3{margin:0 auto 0 0;font-size:14px}
.nw-localization .lw-preview-page select{width:auto;max-width:100%}
.nw-localization .lw-toggle{display:inline-flex;flex-wrap:wrap;border:1px solid var(--nw-border-strong);border-radius:var(--nw-radius-lg);overflow:hidden}
.nw-localization .lw-toggle button{min-height:36px;min-width:44px;padding:0 10px;border:0;background:var(--nw-bg);font-size:12.5px;font-weight:600}
.nw-localization .lw-toggle button+button{border-left:1px solid var(--nw-border-strong)}
.nw-localization .lw-toggle button[aria-pressed=true]{background:var(--nw-accent-soft);color:var(--nw-accent-strong)}
.nw-localization .lw-toggle button[aria-pressed=true]::before{content:"✓ "}
.nw-localization .lw-toggle button:focus-visible{outline-offset:-3px}
.nw-localization .lw-preview-note,.nw-localization .lw-preview-status{margin:0;color:var(--nw-text-sub);font-size:12px}
.nw-localization .lw-frame-wrap{min-width:0;overflow:auto;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg);background:var(--nw-surface)}
.nw-localization .lw-frame{display:block;width:100%;height:70vh;min-height:420px;margin:0 auto;border:0;background:var(--nw-bg)}
.nw-localization .lw-frame-wrap[data-width="360"] .lw-frame{width:360px;max-width:none}
.nw-localization .lw-frame-wrap[data-width="320"] .lw-frame{width:320px;max-width:none}

.nw-localization .lw-dialog{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto}
.nw-localization .lw-dialog-wide{width:min(640px,100%)}
.nw-localization .lw-dialog h2:focus-visible{outline:none}
.nw-localization .lw-dialog-body{display:grid;gap:12px;min-width:0}
.nw-localization .lw-dialog-lead{margin:0;color:var(--nw-text)}
.nw-localization .lw-blockers{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.nw-localization .lw-blockers li{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:8px 10px;border-radius:var(--nw-radius-lg);background:var(--nw-danger-soft);font-size:13px}
.nw-localization .lw-blockers li>span{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}
.nw-localization .lw-plan dd{text-align:right}
.nw-localization .lw-first-release{display:grid;gap:10px;padding:12px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg)}
.nw-localization .lw-first-release h3,.nw-localization .lw-first-release p{margin:0}
.nw-localization .lw-first-release h3{font-size:14px}
.nw-localization .lw-first-release>ul{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.nw-localization .lw-first-release>ul li{display:flex;justify-content:space-between;gap:12px;font-size:13px}
.nw-localization .lw-first-release small{color:var(--nw-text-sub);font-size:12px}
.nw-localization .lw-history{display:grid;gap:0;margin:0;padding:0;list-style:none}
.nw-localization .lw-history-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;min-height:56px;padding:8px 0;border-bottom:1px solid var(--nw-border)}
.nw-localization .lw-history-row[data-current=true]{background:var(--nw-accent-soft);margin:0 -8px;padding:8px}
.nw-localization .lw-history-text{display:grid;flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.nw-localization .lw-inline-banner{border:0;border-radius:var(--nw-radius-lg)}

.nw-localization .lw-settings-body{display:grid;gap:16px;max-width:720px;margin:0 auto;padding:24px 24px 64px}
.nw-localization .lw-settings-body h2{margin:0;font-size:20px}
.nw-localization .lw-settings-body h2:focus-visible{outline:none}
.nw-localization .lw-settings-card{display:grid;gap:10px;padding:18px;border-radius:var(--nw-radius-lg);background:var(--nw-bg);box-shadow:0 0 0 1px var(--nw-border)}
.nw-localization .lw-settings-card h3{margin:0;font-size:14px}
.nw-localization .lw-check{display:flex;align-items:flex-start;gap:10px;min-height:40px;cursor:pointer}
.nw-localization .lw-check input{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--nw-accent)}
.nw-localization .lw-settings-actions{display:flex;gap:8px}

@media (max-width:1099px){
.nw-localization .lw-item-body.lw-with-preview{grid-template-columns:minmax(0,1fr)}
.nw-localization .lw-preview{position:static;max-height:none;border-left:0;border-top:1px solid var(--nw-border)}
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
