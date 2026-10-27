import { uiSelectChevron, uiTokensCss } from "./ui-tokens.js";

/**
 * STUDIO を視覚基準にした、全サイト共通の編集 workspace。
 * 色・角丸・文字は ./ui-tokens.ts のトークン（--nw-* と、入力欄の --e-input* などの編集画面の名前）だけを使う（#71・#159）。
 */
export const workspaceCss = `${uiTokensCss}
/* Shared controls */
.nw-editor{
  display:flex;width:100%;height:100dvh;max-height:100dvh;min-width:320px;min-height:0;flex-direction:column;overflow:hidden;
  border:0;border-radius:0;background:var(--e-ground);color:var(--e-ink);font:var(--nw-font-size-label)/1.45 var(--nw-font)
}
.nw-editor *{box-sizing:border-box}.nw-editor [hidden]{display:none!important}
.nw-editor button,.nw-editor input,.nw-editor select,.nw-editor textarea{font:inherit;color:inherit}
.nw-editor button{min-height:30px;padding:5px 9px;border:1px solid var(--e-border-strong);border-radius:var(--nw-radius-sm);background:var(--nw-bg);cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}
.nw-editor button:hover:not(:disabled){border-color:var(--e-border-strong);background:var(--e-hover)}.nw-editor button:disabled{cursor:default;opacity:.45}
.nw-editor button:focus-visible,.nw-editor input:focus-visible,.nw-editor select:focus-visible,.nw-editor textarea:focus-visible,.nw-editor summary:focus-visible{outline:2px solid var(--e-focus);outline-offset:2px}
.nw-editor button[aria-pressed=true]{border-color:var(--nw-accent-border);background:var(--e-blue-soft);color:var(--nw-accent-strong)}
/* Inputs: one neutral surface for text, number, search, URL, unit, select and textarea. */
.nw-editor input:not([type=checkbox]):not([type=radio]),.nw-editor select,.nw-editor textarea{display:block;width:100%;min-width:0;min-height:30px;padding:5px 8px;border:1px solid var(--e-input-border);border-radius:var(--e-radius);background-color:var(--e-input);color:var(--e-ink)}
.nw-editor select{appearance:none;padding-right:24px;background-image:${uiSelectChevron};background-repeat:no-repeat;background-position:right 7px center;background-size:12px 12px;cursor:pointer}
.nw-editor select:disabled{cursor:not-allowed}.nw-editor input[type=checkbox],.nw-editor input[type=radio]{accent-color:var(--e-blue)}
.nw-editor textarea{min-height:90px;resize:vertical}.nw-editor :is(input,select,textarea):disabled{background-color:var(--e-input-disabled);color:var(--e-muted);cursor:not-allowed}.nw-editor :is(input,textarea)[readonly]{background-color:var(--e-input-disabled)}
.nw-editor :is(input,textarea)::placeholder{color:var(--e-placeholder);opacity:1}.nw-editor :is(input,textarea)[aria-invalid=true]{border-color:var(--nw-danger)}
.nw-editor .e-primary{border-color:var(--nw-accent);background:var(--nw-accent);color:var(--nw-on-accent);font-weight:700}.nw-editor .e-primary:hover:not(:disabled){border-color:var(--nw-accent-strong);background:var(--nw-accent-strong);color:var(--nw-on-accent)}.nw-editor .e-danger{color:var(--nw-danger)}
.nw-editor h2{margin:0 0 12px;font-size:14px}.nw-editor h3{margin:20px 0 8px;color:var(--e-muted);font-size:var(--nw-font-size-sub)}
.nw-editor .e-field{display:block;margin:0 0 11px}.nw-editor .e-field>span{display:block;margin:0 0 4px;color:var(--e-muted);font-size:var(--nw-font-size-sub);font-weight:700}
.nw-editor .e-help{display:block;margin-top:5px;color:var(--e-muted);font-size:11px;overflow-wrap:anywhere}.nw-editor .e-problem{color:var(--nw-danger)}
.nw-editor .e-actions{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.nw-editor .e-small{padding:5px 8px;font-size:11px}.nw-editor .e-search{margin:4px 0 12px}
.nw-editor .e-domain-small{padding:8px;border-radius:var(--nw-radius-sm);background:var(--nw-surface-2);font-size:var(--nw-font-size-sub);word-break:break-all}

/* Workspace columns and bounded scrolling */
.nw-editor .e-body{position:relative;display:grid;grid-template-columns:350px minmax(0,1fr) 300px;min-height:0;flex:1;overflow:hidden}
.nw-editor .e-body.is-left-closed{grid-template-columns:50px minmax(0,1fr) 300px}.nw-editor .e-body.is-right-closed{grid-template-columns:350px minmax(0,1fr)}.nw-editor .e-body.is-left-closed.is-right-closed{grid-template-columns:50px minmax(0,1fr)}
.nw-editor .e-rail{height:100%;min-height:0;background:var(--nw-bg)}.nw-editor .e-left{display:flex;min-width:0;overflow:hidden;border-right:1px solid var(--e-border)}
/* Tool rail: 50px column, 32px buttons, 18px line icons (stroke 1.5). The open tool gets a small grey square like STUDIO's navigation. */
.nw-editor .e-tools{display:flex;width:50px;flex:none;flex-direction:column;align-items:center;gap:4px;padding:8px 4px;border-right:1px solid var(--e-border);background:var(--nw-bg)}
.nw-editor .e-tools button{display:flex;width:32px;height:32px;min-width:32px;min-height:32px;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--nw-radius);background:transparent;color:var(--e-muted)}
.nw-editor .e-tools button:hover:not(:disabled){border-color:transparent;background:var(--e-hover);color:var(--e-ink)}.nw-editor .e-tools button[aria-pressed=true]{border-color:transparent;background:var(--nw-pressed);color:var(--e-ink)}
.nw-editor .e-tools button:disabled{opacity:.35}.nw-editor .e-tools .e-panel-toggle{margin-bottom:4px}.nw-editor .e-tool-icon{display:block;width:18px;height:18px;flex:none}
.nw-editor .e-left-column{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}.nw-editor .e-body.is-left-closed .e-left-column{display:none}.nw-editor .e-project-context{display:grid;min-height:48px;grid-template-columns:minmax(32px,auto) minmax(0,1fr);column-gap:4px;grid-template-rows:20px 16px;align-content:center;padding:4px 8px;border-bottom:1px solid var(--e-border)}
.nw-editor .e-toolbar-start{display:flex;grid-row:1/3;align-items:center;gap:4px}.nw-editor .e-toolbar-start>a{display:grid;width:30px;height:30px;place-items:center;border-radius:var(--nw-radius-sm);color:var(--e-ink);text-decoration:none}.nw-editor .e-toolbar-start>a:hover{background:var(--e-hover)}
/* Breadcrumb: site / page on the first line, the public path (or the kind) under it. Each part truncates on its own. */
.nw-editor .e-crumb,.nw-editor .e-crumb>span,.nw-editor .e-crumb-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nw-editor .e-crumb{display:flex;align-items:baseline;gap:4px;font-size:12px}
.nw-editor .e-crumb-site{flex:0 1 auto;color:var(--e-muted);font-weight:500}.nw-editor .e-crumb-sep{flex:none;color:var(--nw-text-faint);font-weight:400}.nw-editor .e-crumb-page{flex:1 1 auto}.nw-editor .e-crumb-path{color:var(--e-muted);font-size:10px;font-variant-numeric:tabular-nums}
.nw-editor .e-panel{min-width:0;min-height:0;flex:1;overflow:auto}.nw-editor .e-panel>section{padding:14px 12px 22px}.nw-editor .e-panel-head{margin-bottom:12px}.nw-editor .e-panel-head h2{margin:0;font-size:13px}.nw-editor .e-panel-head p{display:none}

/* Layout zoom keeps fixed iframe layers intact; transforming the iframe can drop their initial paint in Chromium. */
/* Canvas begins at the workspace top; only the stage scrolls. */
.nw-editor .e-canvas{position:relative;display:flex;min-width:0;min-height:0;flex-direction:column;overflow:hidden;background:var(--e-ground)}
.nw-editor .e-stage{min-height:0;flex:1;overflow:auto;scrollbar-gutter:stable;padding:20px 20px 84px;background:var(--e-ground)}
/* Keep fit measurements independent of automatic scrollbar visibility. */
@supports not (scrollbar-gutter:stable){.nw-editor .e-stage{overflow-y:scroll}}
.nw-editor .e-canvas-spacer{position:relative;flex:none;margin:0 auto}.nw-editor .e-canvas-scaled{position:absolute;top:0;left:0}
.nw-editor .e-viewport-edge{position:absolute;z-index:8;top:0;bottom:0;width:14px;height:100%;padding:0;border:0;border-radius:0;background:transparent;cursor:ew-resize;touch-action:none}.nw-editor .e-viewport-edge.is-left{left:-7px}.nw-editor .e-viewport-edge.is-right{right:-7px}.nw-editor .e-viewport-edge::before{content:"";position:absolute;top:0;bottom:0;left:6px;width:2px;background:var(--e-border)}.nw-editor .e-viewport-edge:hover::before,.nw-editor .e-viewport-edge:focus-visible::before{background:var(--e-blue)}.nw-editor .e-viewport-edge:disabled{cursor:default}
.nw-editor iframe{display:block;height:800px;max-width:none;margin:0 auto;border:0;outline:1px solid var(--e-border);background:var(--nw-bg)}.nw-editor .e-empty{padding:40px;color:var(--e-muted);text-align:center}
.nw-editor .e-canvas-tools{position:absolute;z-index:10;bottom:16px;left:50%;display:flex;width:auto;height:42px;min-height:42px;max-width:calc(100% - 24px);align-items:center;justify-content:center;gap:5px;padding:5px 7px;border:1px solid var(--e-border);border-radius:var(--nw-radius-lg);background:var(--nw-bg);transform:translateX(-50%)}
.nw-editor .e-width-field{display:flex;width:80px;align-items:center;color:var(--e-muted);white-space:nowrap}.nw-editor .e-width-field input{width:58px;height:30px;padding:4px 3px 4px 7px;border:0;background-color:transparent;text-align:right;font-variant-numeric:tabular-nums}
.nw-editor .e-device-group{display:flex;align-items:center;gap:1px;padding:2px;border-radius:var(--nw-radius-sm);background:var(--e-input)}.nw-editor .e-device-button{display:grid;width:30px;height:28px;min-width:30px;min-height:28px;place-items:center;padding:0;border:0;background:transparent}
.nw-editor .e-device-button[aria-pressed=true]{background:var(--nw-bg);color:var(--e-blue);box-shadow:0 0 0 1px var(--e-border)}.nw-editor .e-device-button .e-action-icon{width:16px;height:16px}
.nw-editor .e-canvas-tools .e-motion-toggle{width:30px;min-width:30px;height:30px;overflow:hidden;padding:0;color:transparent}.nw-editor .e-canvas-tools .e-motion-toggle::before{content:"▶";display:grid;width:30px;height:30px;place-items:center;color:var(--e-muted);font-size:var(--nw-font-size-sub)}
.nw-editor .e-tier-note,.nw-editor .e-canvas-caption{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nw-editor .e-preview-exit{position:absolute;z-index:12;top:12px;right:12px;display:flex;align-items:center;gap:6px}.nw-editor .e-preview-exit .e-action-icon{width:16px;height:16px}

/* Inspector owns document actions and its own scroll container. */
.nw-editor .e-right{display:flex;min-width:0;min-height:0;flex-direction:column;overflow:hidden;border-left:1px solid var(--e-border);background:var(--nw-bg)}
.nw-editor .e-inspector-actions{display:flex;min-height:49px;flex:none;flex-wrap:wrap;align-items:center;gap:2px;padding:7px;border-bottom:1px solid var(--e-border);background:var(--nw-bg)}
.nw-editor .e-inspector-actions .e-status{order:20;min-width:0;flex:1 1 110px;padding:3px 4px;overflow:hidden;color:var(--e-muted);font-size:10px;white-space:nowrap;text-overflow:ellipsis}.nw-editor .e-inspector-actions .e-status.is-dirty{color:var(--nw-warning)}.nw-editor .e-inspector-actions .e-status.is-problem{color:var(--nw-danger);font-weight:700}
.nw-editor .e-inspector-actions .e-status-action{order:21;min-height:24px;padding:2px 6px}.nw-editor .e-inspector-actions .e-autosave{order:22;min-height:24px;margin-left:auto;padding:2px 4px;font-size:10px}.nw-editor .e-inspector-actions .e-language-selector{order:19;width:100%;overflow-x:auto}
.nw-editor .e-action-button,.nw-editor .e-panel-toggle{display:grid;width:28px;height:30px;min-width:28px;min-height:30px;place-items:center;padding:0;border-color:transparent;background:transparent}
.nw-editor .e-action-button:hover:not(:disabled),.nw-editor .e-panel-toggle:hover:not(:disabled){border-color:transparent;background:var(--e-hover)}.nw-editor .e-action-icon{display:block;width:18px;height:18px}.nw-editor .e-save-button{color:var(--e-ink)}
.nw-editor .e-zoom-field{margin-right:auto}.nw-editor .e-zoom-field select{width:78px;height:30px;padding:3px 20px 3px 7px;border:0;background-position:right 5px center}
.nw-editor .e-publish-button{min-width:50px;min-height:30px;padding:4px 10px;border-color:var(--nw-accent);background:var(--nw-accent);color:var(--nw-on-accent);font-size:var(--nw-font-size-sub)}.nw-editor .e-hold{display:none}
.nw-editor .e-inspector-scroll{min-height:0;flex:1;overflow:auto}.nw-editor .e-inspector-context{position:sticky;z-index:4;top:0;display:flex;min-height:46px;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--e-border);background:var(--nw-bg)}
.nw-editor .e-inspector-context strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.nw-editor .e-inspector-context label{flex:0 0 auto;margin:0}.nw-editor .e-inspector-context select{width:auto;max-width:86px;height:30px;padding:4px 23px 4px 7px}.nw-editor .e-condition-select{max-width:92px!important}
.nw-editor .e-inspector-tabs{position:sticky;z-index:3;top:46px;display:flex;gap:3px;padding:6px 8px;border-bottom:1px solid var(--e-border);background:var(--nw-bg)}.nw-editor .e-inspector-tabs button{height:30px;flex:1;padding:4px 5px;border:0;border-radius:var(--nw-radius-sm);background:transparent;color:var(--e-muted)}.nw-editor .e-inspector-tabs button[aria-selected=true]{background:var(--e-hover);color:var(--e-ink);font-weight:700}
.nw-editor .e-inspector-content{padding:13px 10px 28px}
.nw-editor .e-notice,.nw-editor .e-readonly,.nw-editor .e-localization-gate{max-height:96px;flex:none;overflow:auto}.nw-editor .e-notice{padding:8px 12px;border-bottom:1px solid var(--e-border);background:var(--nw-warning-soft);overflow-wrap:anywhere}

.nw-editor.is-preview .e-body{grid-template-columns:minmax(0,1fr)}.nw-editor.is-preview .e-left,.nw-editor.is-preview .e-right{display:none}.nw-editor.is-preview .e-canvas-tools{display:flex}
@media(max-width:1050px){.nw-editor .e-body{grid-template-columns:296px minmax(0,1fr) 292px}.nw-editor .e-body.is-right-closed{grid-template-columns:296px minmax(0,1fr)}}
@media(max-width:820px){
  .nw-editor .e-part-banner{margin-left:50px}
  .nw-editor .e-body,.nw-editor .e-body.is-left-closed,.nw-editor .e-body.is-right-closed,.nw-editor .e-body.is-left-closed.is-right-closed{display:grid;grid-template-columns:minmax(0,1fr)}
  .nw-editor .e-left,.nw-editor .e-right{position:absolute;z-index:20;inset-block:0}.nw-editor .e-left{left:0;width:min(350px,calc(100vw - 50px))}.nw-editor .e-right{right:0;left:auto;width:min(300px,calc(100vw - 50px))}
  .nw-editor .e-body.is-left-closed .e-left{width:50px}
}
/* 320px: the inspector header wraps instead of pushing its close button out, and the viewport bar stays inside the stage. */
@media(max-width:480px){
  .nw-editor .e-inspector-context{flex-wrap:wrap;min-height:0;gap:4px 6px;padding:6px 8px}.nw-editor .e-inspector-context strong{flex:1 1 100%}
  .nw-editor .e-canvas-tools{height:auto;flex-wrap:wrap;gap:3px;padding:4px 5px}.nw-editor .e-width-field{width:70px}.nw-editor .e-width-field input{width:48px;padding-left:4px}
  .nw-editor .e-inspector-actions .e-status{flex-basis:70px}
}
`;
