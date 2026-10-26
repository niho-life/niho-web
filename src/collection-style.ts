import { uiTokensCss } from "./ui-tokens.js";

/**
 * CollectionWorkspace の CSS。部品は <style> でも入れるが、inline の <style> を CSP で拒むホスト（Studio）は
 * この文字列をファイルにして読み込む。色・角丸・文字は ./ui-tokens.ts のトークン（--nw-*）だけを使い、先頭にトークンの定義を持つ（#159）。
 */
export const collectionCss = `${uiTokensCss}.nw-collection{position:relative;min-width:0;max-width:100%;color:var(--nw-text);background:var(--nw-bg);font:var(--nw-font-size)/1.6 var(--nw-font);-webkit-font-smoothing:antialiased}
.nw-collection *{box-sizing:border-box}
.nw-collection :is(button,input,select,textarea){font:inherit;color:inherit}
.nw-collection button{position:relative;cursor:pointer}
.nw-collection button:disabled{cursor:default;opacity:.55}
.nw-collection :is(button,a,input,select,textarea,[contenteditable],[tabindex]):focus-visible{outline:2px solid var(--nw-focus);outline-offset:2px}
.nw-collection .cw-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.nw-collection .cw-icon{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.nw-collection .cw-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 14px;border:1px solid var(--nw-border-strong);border-radius:var(--nw-radius-lg);background:var(--nw-bg);color:var(--nw-text);font-weight:600;white-space:nowrap;text-decoration:none}
.nw-collection .cw-button:hover:not(:disabled){background:var(--nw-hover)}
.nw-collection .cw-primary{background:var(--nw-accent);border-color:var(--nw-accent);color:var(--nw-on-accent)}
.nw-collection .cw-primary:hover:not(:disabled){border-color:var(--nw-accent-strong);background:var(--nw-accent-strong)}
/* 黒は作成系だけ（一覧の見出しの「＋ 新しい○○」） */
.nw-collection .cw-list-actions .cw-primary{border-color:var(--nw-inverse);background:var(--nw-inverse);color:var(--nw-on-inverse)}
.nw-collection .cw-list-actions .cw-primary:hover:not(:disabled){border-color:var(--nw-inverse-hover);background:var(--nw-inverse-hover)}
.nw-collection .cw-danger{background:var(--nw-danger);border-color:var(--nw-danger);color:var(--nw-on-danger)}
.nw-collection .cw-danger:hover:not(:disabled){background:var(--nw-danger);filter:brightness(1.1)}
.nw-collection .cw-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:0;border:0;border-radius:var(--nw-radius-lg);background:transparent;color:var(--nw-text-sub)}
.nw-collection .cw-icon-button:hover{background:var(--nw-hover);color:var(--nw-text)}
.nw-collection .cw-link-button{min-height:40px;padding:0 4px;border:0;background:none;color:var(--nw-accent-strong);font-weight:600;text-decoration:underline;text-underline-offset:3px}
.nw-collection .cw-notice,.nw-collection .cw-empty{display:grid;justify-items:center;gap:12px;padding:56px 16px;text-align:center;color:var(--nw-text-sub)}
.nw-collection .cw-notice p,.nw-collection .cw-empty p{margin:0;max-width:34em}
.nw-collection .cw-badges{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}
.nw-collection .cw-pill{display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 9px 0 7px;border-radius:var(--nw-radius-pill);background:var(--nw-surface-2);color:var(--nw-text-sub);font-size:12px;font-weight:650;line-height:1.3;white-space:nowrap}
.nw-collection .cw-pill .cw-icon{width:13px;height:13px;stroke-width:2.2}
.nw-collection .cw-dot{width:8px;height:8px;flex:none;border-radius:50%;background:currentColor}
.nw-collection .cw-pill[data-status=draft] .cw-dot{background:transparent;border:1.6px solid currentColor}
.nw-collection .cw-pill[data-status=published]{background:var(--nw-surface-2);color:var(--nw-text)}
.nw-collection .cw-pill[data-status=published] .cw-dot{background:var(--nw-live)}
.nw-collection .cw-pill[data-status=changed]{background:var(--nw-accent-soft);color:var(--nw-accent-strong)}
.nw-collection .cw-pill[data-status=changed] .cw-dot{background:linear-gradient(90deg,currentColor 50%,transparent 50%);border:1.6px solid currentColor}
.nw-collection .cw-pill[data-status=publishing]{background:var(--nw-accent-soft);color:var(--nw-accent-strong)}
.nw-collection .cw-pill[data-status=scheduled]{background:var(--nw-warning-soft);color:var(--nw-warning)}
.nw-collection .cw-pill[data-status=scheduled] .cw-dot{border-radius:var(--nw-radius-sm)}
.nw-collection .cw-pill[data-status=failed]{background:var(--nw-danger-soft);color:var(--nw-danger)}
.nw-collection .cw-spin{width:10px;height:10px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cw-spin .8s linear infinite}
@keyframes cw-spin{to{transform:rotate(360deg)}}

.nw-collection .cw-layout{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100%}
.nw-collection .cw-nav{padding:18px 12px;border-right:1px solid var(--nw-border);background:var(--nw-surface);min-width:0}
.nw-collection .cw-nav-heading{margin:0;padding:4px 10px 8px;color:var(--nw-text-sub);font-size:var(--nw-font-size-sub);font-weight:700}
.nw-collection .cw-nav ul{display:grid;gap:2px;margin:0;padding:0;list-style:none}
.nw-collection .cw-nav button{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:0 10px;border:0;border-radius:var(--nw-radius-lg);background:transparent;color:var(--nw-text-sub);font-weight:600;text-align:left}
.nw-collection .cw-nav button:hover{background:var(--nw-hover);color:var(--nw-text)}
.nw-collection .cw-nav button[aria-current=page]{background:var(--nw-bg);color:var(--nw-text);box-shadow:0 0 0 1px var(--nw-border)}
.nw-collection .cw-nav-label{min-width:0;overflow-wrap:anywhere}
.nw-collection .cw-nav-count{margin-left:auto;color:var(--nw-text-sub);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.nw-collection .cw-main{min-width:0}
.nw-collection .cw-list{padding:24px 32px 64px;container:cw-list/inline-size}
.nw-collection .cw-list-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.nw-collection .cw-list-title{display:flex;align-items:baseline;gap:10px;min-width:0}
.nw-collection .cw-list-title h2{margin:0;font-size:22px;line-height:1.35;overflow-wrap:anywhere}
.nw-collection .cw-count{color:var(--nw-text-sub);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.nw-collection .cw-list-actions{display:flex;align-items:center;gap:10px;margin-left:auto;min-width:0;flex-wrap:wrap}
.nw-collection .cw-search{display:flex;align-items:center;gap:6px;width:240px;min-width:0;min-height:40px;padding:0 10px;border:1px solid var(--nw-border);border-radius:var(--nw-radius);background:var(--nw-surface-2);color:var(--nw-text-sub)}
.nw-collection .cw-search:focus-within{outline:2px solid var(--nw-focus);outline-offset:2px}
.nw-collection .cw-search input{flex:1;min-width:0;height:38px;border:0;background:transparent;color:var(--nw-text)}
.nw-collection .cw-search input:focus-visible{outline:none}
.nw-collection .cw-filters{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;border-bottom:1px solid var(--nw-border)}
.nw-collection .cw-filters button{min-height:40px;margin-bottom:-1px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--nw-text-sub);font-weight:600;white-space:normal}
.nw-collection .cw-filters button[aria-pressed=true]{border-bottom-color:var(--nw-text);color:var(--nw-text)}
.nw-collection .cw-filters button:focus-visible{outline-offset:-3px}
.nw-collection .cw-filter-count{margin-left:4px;color:var(--nw-text-sub);font-weight:500;font-variant-numeric:tabular-nums}
.nw-collection .cw-rows{margin:0;padding:0;list-style:none}
.nw-collection .cw-rows-head,.nw-collection .cw-row{display:grid;grid-template-columns:minmax(0,1fr) 172px 136px 150px 40px;align-items:center;column-gap:12px}
.nw-collection .cw-rows-head{min-height:40px;padding:0 6px;border-bottom:1px solid var(--nw-border);color:var(--nw-text-sub);font-size:12px;font-weight:600}
.nw-collection .cw-row{min-height:64px;padding:0 6px;border-bottom:1px solid var(--nw-border)}
.nw-collection .cw-row:hover{background:var(--nw-surface)}
.nw-collection .cw-row-meta{display:contents}
.nw-collection .cw-row-open{display:flex;align-items:center;justify-content:flex-start;gap:12px;min-width:0;min-height:56px;padding:8px 0;border:0;background:transparent;color:inherit;text-align:left}
.nw-collection .cw-row-open:hover .cw-row-title{text-decoration:underline;text-underline-offset:3px}
.nw-collection .cw-thumb{display:grid;place-items:center;flex:none;width:56px;height:42px;overflow:hidden;border-radius:var(--nw-radius);background:var(--nw-hover);color:var(--nw-text-sub)}
.nw-collection .cw-thumb[data-shape=round]{width:42px;border-radius:50%}
.nw-collection .cw-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.nw-collection .cw-row-text{display:grid;gap:1px;min-width:0}
.nw-collection .cw-row-title{overflow:hidden;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.nw-collection .cw-row-sub{overflow:hidden;color:var(--nw-text-sub);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.nw-collection .cw-cell{min-width:0;color:var(--nw-text-sub);font-size:13px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.nw-collection .cw-cell-updated{display:grid;line-height:1.4}
.nw-collection .cw-by{color:var(--nw-text-sub);font-size:12px}
.nw-collection .cw-cell-label{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nw-collection .cw-menu-wrap{position:relative;display:inline-flex}
.nw-collection .cw-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:30;display:grid;min-width:200px;max-width:calc(100vw - 32px);padding:6px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg);background:var(--nw-bg)}
.nw-collection .cw-menu button{display:flex;align-items:center;width:100%;min-height:40px;padding:0 10px;border:0;border-radius:var(--nw-radius);background:transparent;color:var(--nw-text);font-size:14px;text-align:left;white-space:nowrap}
.nw-collection .cw-menu button:hover,.nw-collection .cw-menu button:focus-visible{background:var(--nw-hover)}
.nw-collection .cw-menu button:focus-visible{outline-offset:-3px}
.nw-collection .cw-menu .cw-danger-text{color:var(--nw-danger)}
.nw-collection .cw-danger-outline{border-color:var(--nw-danger);color:var(--nw-danger)}
.nw-collection .cw-check{display:inline-flex;align-items:center;gap:8px;min-height:40px;cursor:pointer}
.nw-collection .cw-check input{flex:none;width:18px;height:18px;margin:0;accent-color:var(--nw-accent);cursor:pointer}
.nw-collection .cw-list-hint{margin:8px 0 0}
.nw-collection .cw-bulk{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;min-height:48px;padding:4px 6px;border-bottom:1px solid var(--nw-border)}
.nw-collection .cw-bulk[data-active=true]{background:var(--nw-accent-soft)}
.nw-collection .cw-bulk-count{font-size:13px;font-weight:650;font-variant-numeric:tabular-nums}
.nw-collection .cw-bulk-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:auto}
.nw-collection .cw-bulk-errors{margin:8px 0;padding:10px 14px;border-radius:var(--nw-radius-lg);background:var(--nw-danger-soft);box-shadow:inset 4px 0 0 var(--nw-danger);font-size:13px}
.nw-collection .cw-bulk-errors p{margin:0 0 4px;font-weight:650}
.nw-collection .cw-bulk-errors ul{margin:0;padding-left:18px}
.nw-collection .cw-list>.cw-warn{margin:8px 0 0}
.nw-collection .cw-table[data-lead=select]{--cw-lead:40px}
.nw-collection .cw-table[data-lead=grip]{--cw-lead:28px}
.nw-collection .cw-table[data-lead=both]{--cw-lead:68px}
.nw-collection .cw-table[data-lead] :is(.cw-rows-head,.cw-row){grid-template-columns:var(--cw-lead) minmax(0,1fr) 172px 136px 150px 40px}
.nw-collection .cw-row-lead{display:flex;align-items:center;min-width:0}
.nw-collection .cw-row-check{justify-content:center;width:40px}
.nw-collection .cw-handle{display:grid;place-items:center;flex:none;width:28px;height:40px;border-radius:var(--nw-radius);color:var(--nw-text-sub);cursor:grab;touch-action:none;user-select:none}
.nw-collection .cw-handle:hover{background:var(--nw-hover);color:var(--nw-text)}
.nw-collection .cw-handle[data-disabled=true]{opacity:.35;cursor:progress}
.nw-collection .cw-handle-slot{flex:none;width:28px}
.nw-collection .cw-rows[data-dragging=true]{cursor:grabbing;user-select:none}
.nw-collection .cw-row[data-dragging=true]{background:var(--nw-surface);opacity:.6}
.nw-collection .cw-row[data-drop=before]{box-shadow:inset 0 3px 0 var(--nw-focus)}
.nw-collection .cw-row[data-drop=after]{box-shadow:inset 0 -3px 0 var(--nw-focus)}
.nw-collection .cw-rows[aria-busy=true] .cw-handle{cursor:progress}

.nw-collection .cw-toast-region{position:fixed;bottom:24px;left:50%;z-index:60;width:max-content;max-width:calc(100vw - 32px);transform:translateX(-50%)}
.nw-collection .cw-toast{display:flex;align-items:center;gap:8px;padding:4px 4px 4px 14px;border-radius:var(--nw-radius-lg);background:var(--nw-inverse);color:var(--nw-on-inverse)}
.nw-collection .cw-toast[data-tone=error]{background:var(--nw-danger);color:var(--nw-on-danger)}
.nw-collection .cw-toast p{margin:0;font-size:13.5px}
.nw-collection .cw-toast .cw-icon-button{color:inherit}
.nw-collection .cw-toast .cw-icon-button:hover{background:var(--nw-on-inverse-hover)}
.nw-collection .cw-backdrop{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:var(--nw-overlay)}
.nw-collection .cw-dialog{display:grid;gap:12px;width:min(440px,100%);padding:20px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg);background:var(--nw-bg)}
.nw-collection .cw-dialog h2{margin:0;font-size:17px;line-height:1.45}
.nw-collection .cw-dialog p{margin:0;color:var(--nw-text-sub)}
.nw-collection .cw-dialog-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:4px}
.nw-collection .cw-choices{display:grid;gap:2px;min-width:0;margin:0;padding:0;border:0}
.nw-collection .cw-choices legend{margin-bottom:4px;padding:0;font-size:13px;font-weight:650;overflow-wrap:anywhere}
.nw-collection .cw-choice{display:flex;align-items:flex-start;gap:10px;min-height:40px;padding:9px 0;cursor:pointer}
.nw-collection .cw-choice input{flex:none;width:18px;height:18px;margin:2px 0 0;accent-color:var(--nw-accent);cursor:pointer}
.nw-collection .cw-choice>span{display:grid;gap:2px;min-width:0}
.nw-collection .cw-select{max-width:100%;margin:0 0 4px 28px;width:calc(100% - 28px)}

.nw-collection .cw-editor{display:flex;flex-direction:column;min-height:100%;min-width:0}
.nw-collection .cw-editor-bar{position:sticky;top:var(--niho-sticky-top,0px);z-index:5;display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:56px;padding:8px 12px;border-bottom:1px solid var(--nw-border);background:var(--nw-bg)}
.nw-collection .cw-back{display:inline-flex;align-items:center;gap:2px;min-height:40px;padding:0 12px 0 6px;border:0;border-radius:var(--nw-radius-lg);background:transparent;color:var(--nw-text);font-weight:600}
.nw-collection .cw-back:hover{background:var(--nw-hover)}
.nw-collection .cw-editor-status{display:flex;align-items:center;flex:1 1 auto;flex-wrap:wrap;gap:4px 10px;min-width:0}
.nw-collection .cw-save-state{color:var(--nw-text-sub);font-size:12.5px}
.nw-collection .cw-editor-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:auto}
.nw-collection .cw-language-tabs{display:flex;gap:20px;min-height:44px;padding:0 24px;border-bottom:1px solid var(--nw-border);background:var(--nw-bg)}
.nw-collection .cw-language-tabs>span,.nw-collection .cw-language-tabs>a,.nw-collection .cw-language-tabs>button{display:inline-flex;align-items:center;min-height:44px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--nw-text-sub);font:inherit;font-size:13px;font-weight:650;text-decoration:none}
.nw-collection .cw-language-tabs>[aria-current=page]{border-bottom-color:var(--nw-text);color:var(--nw-text)}
.nw-collection .cw-language-tabs>a:hover,.nw-collection .cw-language-tabs>button:hover{color:var(--nw-text)}
.nw-collection .cw-language-tabs>a:focus-visible,.nw-collection .cw-language-tabs>button:focus-visible{outline:2px solid var(--nw-focus);outline-offset:-2px}
.nw-collection .cw-banner{display:flex;align-items:flex-start;flex-wrap:wrap;gap:8px 12px;padding:10px 16px;border-bottom:1px solid var(--nw-border);background:var(--nw-accent-soft);color:var(--nw-text);font-size:13.5px}
.nw-collection .cw-banner[data-tone=error]{background:var(--nw-danger-soft);box-shadow:inset 4px 0 0 var(--nw-danger)}
.nw-collection .cw-banner p{flex:1 1 260px;margin:0;align-self:center}
.nw-collection .cw-banner ul{margin:0;padding-left:18px}
.nw-collection .cw-editor-body{display:grid;grid-template-columns:minmax(0,1fr) 340px;flex:1}
.nw-collection .cw-editor-main{min-width:0;padding:28px 32px 80px;background:var(--nw-surface)}
.nw-collection .cw-card{display:grid;gap:22px;max-width:780px;min-width:0;margin:0 auto;padding:28px 32px 40px;border-radius:var(--nw-radius-lg);background:var(--nw-bg);box-shadow:0 0 0 1px var(--nw-border)}
.nw-collection .cw-editor-side{min-width:0;padding:4px 20px 40px;border-left:1px solid var(--nw-border);background:var(--nw-bg)}
.nw-collection .cw-side-section{display:grid;gap:16px;padding:16px 0;border-bottom:1px solid var(--nw-border)}
.nw-collection .cw-side-section:last-child{border-bottom:0}
.nw-collection .cw-side-section h3{margin:0;color:var(--nw-text-sub);font-size:var(--nw-font-size-label);font-weight:700}
.nw-collection .cw-facts{display:grid;gap:6px;margin:0}
.nw-collection .cw-facts>div{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;min-height:28px;font-size:13px}
.nw-collection .cw-facts dt{color:var(--nw-text-sub)}
.nw-collection .cw-facts dd{min-width:0;margin:0;text-align:right;overflow-wrap:anywhere}
.nw-collection .cw-address{font-family:var(--nw-font-mono);font-size:12.5px}
.nw-collection .cw-schedule{display:grid;gap:8px}
.nw-collection .cw-schedule p{margin:0;font-size:13px}

.nw-collection .cw-field{display:grid;gap:6px;min-width:0}
.nw-collection .cw-label{color:var(--nw-text);font-size:13px;font-weight:650}
.nw-collection .cw-required{margin-left:2px;color:var(--nw-danger);font-size:12px;font-weight:600}
.nw-collection .cw-hint{margin:0;color:var(--nw-text-sub);font-size:12px;line-height:1.55}
.nw-collection .cw-warn{padding:8px 10px;border-radius:var(--nw-radius-lg);background:var(--nw-warning-soft);color:var(--nw-warning)}
.nw-collection .cw-error{display:flex;align-items:flex-start;gap:6px;margin:0;color:var(--nw-danger);font-size:12.5px;font-weight:650;line-height:1.5}
.nw-collection .cw-error .cw-icon{width:15px;height:15px;margin-top:2px}
.nw-collection .cw-input{width:100%;min-width:0;min-height:40px;padding:8px 10px;border:1px solid var(--nw-border);border-radius:var(--nw-radius);background:var(--nw-surface-2);font-size:var(--nw-font-size)}
.nw-collection .cw-input::placeholder{color:var(--nw-text-faint);opacity:1}
.nw-collection .cw-input[aria-invalid=true],.nw-collection .cw-search:has(input[aria-invalid=true]),.nw-collection .cw-slug:has(input[aria-invalid=true]){border-color:var(--nw-danger);box-shadow:0 0 0 1px var(--nw-danger)}
.nw-collection .cw-textarea{resize:vertical;line-height:1.6}
.nw-collection .cw-title-input{min-height:48px;padding:4px 0 10px;border:0;border-bottom:1px solid var(--nw-border-strong);border-radius:0;background:transparent;font-size:24px;font-weight:700;line-height:1.35}
.nw-collection .cw-counter{justify-self:end;color:var(--nw-text-sub);font-size:11.5px;font-variant-numeric:tabular-nums}
.nw-collection .cw-counter.cw-over{color:var(--nw-danger);font-weight:650}
.nw-collection .cw-slug{display:flex;align-items:stretch;min-width:0;overflow:hidden;border:1px solid var(--nw-border);border-radius:var(--nw-radius);background:var(--nw-surface-2)}
.nw-collection .cw-slug:focus-within{outline:2px solid var(--nw-focus);outline-offset:2px}
.nw-collection .cw-slug span{display:flex;align-items:center;max-width:55%;padding-left:10px;overflow:hidden;color:var(--nw-text-sub);font-size:12.5px;text-overflow:ellipsis;white-space:nowrap}
.nw-collection .cw-slug .cw-input{border:0;box-shadow:none;padding-left:2px}
.nw-collection .cw-slug .cw-input:focus-visible{outline:none}
.nw-collection .cw-inline{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.nw-collection .cw-inline .cw-input{flex:1 1 160px;width:auto}
.nw-collection .cw-image{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:12px}
.nw-collection .cw-image-preview{display:grid;place-items:center;width:112px;height:76px;overflow:hidden;border-radius:var(--nw-radius-lg);background:var(--nw-hover);color:var(--nw-text-sub)}
.nw-collection .cw-image[data-shape=round] .cw-image-preview{width:76px;border-radius:50%}
.nw-collection .cw-image-preview img{display:block;width:100%;height:100%;object-fit:cover}
.nw-collection .cw-image-empty{display:grid;justify-items:center;gap:2px;font-size:11px}
.nw-collection .cw-image-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.nw-collection .cw-image>p{grid-column:1/-1}
.nw-collection .cw-redirect{display:grid;gap:6px}
.nw-collection .cw-redirect .cw-check{align-items:flex-start;font-size:13px;line-height:1.55}
.nw-collection .cw-redirect .cw-check input{margin-top:2px}
.nw-collection .cw-redirect .cw-address{overflow-wrap:anywhere}
.nw-collection .cw-gallery{display:grid;gap:10px;min-width:0}
.nw-collection .cw-gallery-rows{display:grid;gap:10px;margin:0;padding:0;list-style:none}
.nw-collection .cw-gallery-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 14px;min-width:0;padding:12px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg)}
.nw-collection .cw-gallery-media{display:grid;align-content:start;justify-items:start;gap:8px}
.nw-collection .cw-gallery-text{display:grid;gap:6px;min-width:0}
.nw-collection .cw-gallery-actions{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}
.nw-collection .cw-gallery-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}
.nw-collection .cw-options{display:flex;flex-wrap:wrap;gap:6px}
.nw-collection .cw-option{position:relative;display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border:1px solid var(--nw-border-strong);border-radius:var(--nw-radius-pill);font-size:13px;cursor:pointer}
.nw-collection .cw-option input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.nw-collection .cw-option:has(input:checked){border-color:var(--nw-accent);background:var(--nw-accent-soft);color:var(--nw-accent-strong)}
.nw-collection .cw-option:has(input:checked) span::before{content:"✓ "}
.nw-collection .cw-option:has(input:focus-visible){outline:2px solid var(--nw-focus);outline-offset:2px}
.nw-collection .cw-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.nw-collection .cw-chip{display:inline-flex;align-items:center;max-width:100%;min-height:40px;padding-left:12px;border-radius:var(--nw-radius-pill);background:var(--nw-hover);font-size:13px}
.nw-collection .cw-chip>span{min-width:0;overflow-wrap:anywhere}
.nw-collection .cw-chip-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:0;border:0;border-radius:var(--nw-radius-pill);background:transparent;color:var(--nw-text-sub)}
.nw-collection .cw-chip-remove:hover{background:var(--nw-border);color:var(--nw-text)}
.nw-collection .cw-chip-remove .cw-icon{width:14px;height:14px}
.nw-collection .cw-reference,.nw-collection .cw-tags{display:grid;gap:8px;min-width:0}
.nw-collection .cw-reference-search{width:100%}
.nw-collection .cw-reference-list{max-height:280px;overflow:auto;padding:4px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg);background:var(--nw-bg)}
.nw-collection .cw-reference-list>p{padding:8px}
.nw-collection .cw-reference-options{margin:0;padding:0;list-style:none}
.nw-collection .cw-reference-options button{display:block;width:100%;min-height:40px;padding:0 10px;border:0;border-radius:var(--nw-radius);background:transparent;text-align:left;overflow-wrap:anywhere}
.nw-collection .cw-reference-options button:hover{background:var(--nw-hover)}
.nw-collection .cw-rich{min-width:0;overflow:hidden;border:1px solid var(--nw-border-strong);border-radius:var(--nw-radius-lg);background:var(--nw-bg)}
.nw-collection .cw-rich.cw-invalid{border-color:var(--nw-danger);box-shadow:0 0 0 1px var(--nw-danger)}
.nw-collection .cw-rich-tools{display:flex;flex-wrap:wrap;gap:2px;padding:4px;border-bottom:1px solid var(--nw-border);background:var(--nw-surface)}
.nw-collection .cw-tool{display:inline-flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;padding:0 8px;border:0;border-radius:var(--nw-radius);background:transparent;color:var(--nw-text);font-size:13px;font-weight:600}
.nw-collection .cw-tool:hover{background:var(--nw-hover)}
.nw-collection .cw-tool [data-tool=bold]{font-weight:800}
.nw-collection .cw-tool [data-tool=italic]{font-family:Georgia,serif;font-style:italic}
.nw-collection .cw-rich-link{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--nw-border);background:var(--nw-surface)}
.nw-collection .cw-rich-link .cw-input{flex:1 1 200px;width:auto}
.nw-collection .cw-rich-link .cw-error{flex-basis:100%}
.nw-collection .cw-rich-area{min-height:280px;padding:14px 18px 24px;font-size:15px;line-height:1.85;overflow-wrap:anywhere}
.nw-collection .cw-rich-area:focus-visible{outline-offset:-3px}
.nw-collection .cw-rich-area :is(h2,h3,h4){line-height:1.45}
.nw-collection .cw-rich-area h2{margin:1.2em 0 .6em;font-size:20px}
.nw-collection .cw-rich-area h3{margin:1.1em 0 .5em;font-size:17px}
.nw-collection .cw-rich-area h4{margin:1em 0 .4em;font-size:15px}
.nw-collection .cw-rich-area p{margin:.7em 0}
.nw-collection .cw-rich-area blockquote{margin:1em 0;padding-left:12px;border-left:3px solid var(--nw-border);color:var(--nw-text-sub)}
.nw-collection .cw-rich-area :is(ul,ol){padding-left:1.5em}
.nw-collection .cw-rich-area img{max-width:100%;height:auto}
.nw-collection .cw-rich-area figure{margin:1em 0}
.nw-collection .cw-rich-area figcaption{color:var(--nw-text-sub);font-size:12px}
.nw-collection .cw-rich-area a{color:var(--nw-accent-strong)}
.nw-collection .cw-rich>p{margin:0;padding:8px 12px;border-top:1px solid var(--nw-border)}

@media (max-width:1099px){.nw-collection .cw-editor-body{grid-template-columns:minmax(0,1fr) 300px}.nw-collection .cw-editor-main{padding:24px 24px 64px}}
@media (max-width:899px){
.nw-collection .cw-layout{grid-template-columns:minmax(0,1fr)}
.nw-collection .cw-nav{padding:8px 12px;border-right:0;border-bottom:1px solid var(--nw-border);overflow-x:visible}
.nw-collection .cw-nav-heading{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nw-collection .cw-nav ul{display:flex;flex-wrap:wrap;gap:4px}
.nw-collection .cw-nav li{flex:none}
.nw-collection .cw-nav button{width:auto;white-space:nowrap}
.nw-collection .cw-list{padding:18px 16px 48px}
.nw-collection .cw-editor-body{grid-template-columns:minmax(0,1fr)}
.nw-collection .cw-editor-main{padding:16px 16px 32px}
.nw-collection .cw-editor-side{padding:4px 16px 40px;border-top:1px solid var(--nw-border);border-left:0}
.nw-collection .cw-card{padding:20px 18px 28px}
.nw-collection :is(.cw-input,.cw-search input){font-size:16px}
.nw-collection .cw-title-input{font-size:21px}
}
@media (max-width:640px){
.nw-collection .cw-list-title h2{font-size:20px}
.nw-collection .cw-list-actions{width:100%;margin-left:0}
.nw-collection .cw-search{flex:1 1 140px;width:auto}
.nw-collection .cw-back-label{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nw-collection .cw-back{padding:0 8px}
.nw-collection .cw-editor-status{order:3;flex-basis:100%}
.nw-collection .cw-image-preview{width:96px;height:64px}
.nw-collection .cw-image[data-shape=round] .cw-image-preview{width:64px}
.nw-collection .cw-toast-region{bottom:16px}
.nw-collection .cw-gallery-row{grid-template-columns:minmax(0,1fr)}
.nw-collection .cw-gallery-media{grid-template-columns:auto minmax(0,1fr);align-items:center}
}
/* 一覧の行は画面ではなく一覧そのものの幅で 2 段にする（ホストの画面の左のメニューなどで一覧が狭いときも題名を潰さない） */
@container cw-list (max-width:880px){
.nw-collection .cw-rows-head{display:none}
.nw-collection .cw-row{grid-template-columns:minmax(0,1fr) 40px;column-gap:4px;padding:0}
.nw-collection .cw-row-open{grid-column:1;grid-row:1;align-items:flex-start;padding:12px 0 6px}
.nw-collection .cw-row-menu{grid-column:2;grid-row:1;align-self:start;margin-top:8px}
.nw-collection .cw-row-meta{grid-column:1/-1;grid-row:2;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:0 0 12px 68px}
.nw-collection .cw-cell{font-size:12px}
.nw-collection .cw-cell-label{position:static;width:auto;height:auto;margin:0 4px 0 0;overflow:visible;clip:auto}
.nw-collection .cw-cell-status .cw-cell-label{display:none}
.nw-collection .cw-cell-updated{display:block}
.nw-collection .cw-cell-updated .cw-by{margin-left:6px}
.nw-collection .cw-row-title{display:-webkit-box;white-space:normal;line-height:1.45;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.nw-collection .cw-table[data-lead] .cw-row{grid-template-columns:var(--cw-lead) minmax(0,1fr) 40px}
.nw-collection .cw-table[data-lead] .cw-row-lead{grid-column:1;grid-row:1;align-self:start;margin-top:8px}
.nw-collection .cw-table[data-lead] .cw-row-open{grid-column:2}
.nw-collection .cw-table[data-lead] .cw-row-menu{grid-column:3}
.nw-collection .cw-table[data-lead] .cw-row-meta{grid-column:2/-1}
.nw-collection .cw-bulk-actions{margin-left:0}
}
@container cw-list (max-width:400px){
.nw-collection .cw-table[data-lead] .cw-thumb,.nw-collection .cw-table[data-lead] .cw-thumb[data-shape=round]{width:36px;height:36px}
.nw-collection .cw-table[data-lead] .cw-row-open{gap:8px}
.nw-collection .cw-table[data-lead] .cw-row-meta{padding-left:44px}
}
@media (prefers-reduced-motion:reduce){.nw-collection .cw-spin{animation:none;border-right-color:currentColor;opacity:.6}}
`;
