/**
 * Studio の本文の編集部品（./rich-text-editor.tsx）の CSS。Studio は CSP で inline の <style> を拒むので、
 * studio/build.mjs がこの文字列を assets/studio.css の後ろに足す。TipTap の injectCSS は使わない（ProseMirror の基本の指定もここ）。
 * 色・角丸は ../src/ui-tokens.ts のトークン（--nw-*）だけを使う（#159）。Studio は assets/studio.css の先頭、ほかのホストは collectionCss の先頭でトークンを読み込む。
 */
export const studioRichTextCss = `
.studio-rich .studio-rich-mount{min-width:0}
.studio-rich [hidden]{display:none!important}
.studio-rich .ProseMirror{position:relative;min-height:320px;padding:16px 20px 28px;font-size:15px;line-height:1.85;color:var(--nw-text);overflow-wrap:anywhere;word-wrap:break-word;white-space:pre-wrap;white-space:break-spaces;font-variant-ligatures:none;font-feature-settings:"liga" 0;outline:0}
.studio-rich .ProseMirror:focus-visible{outline:2px solid var(--nw-focus);outline-offset:-3px}
.studio-rich .ProseMirror [contenteditable=false]{white-space:normal}
.studio-rich .ProseMirror [contenteditable=false] [contenteditable=true]{white-space:pre-wrap}
.studio-rich .ProseMirror img.ProseMirror-separator{display:inline!important;border:none!important;margin:0!important;width:0!important;height:0!important}
.studio-rich .ProseMirror-gapcursor{display:none;pointer-events:none;position:absolute;margin:0}
.studio-rich .ProseMirror-gapcursor:after{content:"";display:block;position:absolute;top:-2px;width:20px;border-top:1px solid currentColor;animation:studio-rich-blink 1.1s steps(2,start) infinite}
.studio-rich .ProseMirror-focused .ProseMirror-gapcursor{display:block}
@keyframes studio-rich-blink{to{visibility:hidden}}
.studio-rich .ProseMirror-hideselection *::selection{background:transparent}
.studio-rich .ProseMirror-hideselection *{caret-color:transparent}
.studio-rich .ProseMirror-selectednode{outline:2px solid var(--nw-focus);outline-offset:3px;border-radius:var(--nw-radius-lg)}
.studio-rich .ProseMirror>:first-child{margin-top:0}
.studio-rich .ProseMirror p{margin:.7em 0;min-height:1em}
.studio-rich .ProseMirror :is(h1,h2,h3,h4){line-height:1.45;scroll-margin-top:24px}
.studio-rich .ProseMirror h1{margin:1.3em 0 .6em;font-size:23px}
.studio-rich .ProseMirror h2{margin:1.4em 0 .6em;padding:4px 12px;border-left:4px solid var(--nw-text);background:var(--nw-surface);font-size:19px}
.studio-rich .ProseMirror h3{margin:1.2em 0 .5em;padding-left:12px;border-left:3px solid var(--nw-border);font-size:16.5px}
.studio-rich .ProseMirror h4{margin:1em 0 .4em;font-size:15px}
.studio-rich .ProseMirror a{color:var(--nw-accent);text-decoration:underline}
.studio-rich .ProseMirror blockquote{margin:1em 0;padding:4px 0 4px 14px;border-left:3px solid var(--nw-border);color:var(--nw-text-sub)}
.studio-rich .ProseMirror :is(ul,ol){margin:1em 0;padding-left:1.6em}
.studio-rich .ProseMirror li>p{margin:.2em 0}
.studio-rich .ProseMirror hr{margin:24px 0;border:0;border-top:1px solid var(--nw-border)}
.studio-rich .ProseMirror code{padding:1px 4px;border-radius:var(--nw-radius-sm);background:var(--nw-surface);font-size:.92em}
.studio-rich .ProseMirror img{max-width:100%;height:auto}
.studio-rich .ProseMirror figure{position:relative;margin:1.2em 0}
.studio-rich .ProseMirror figure img{display:block;width:100%;max-height:520px;object-fit:contain;border-radius:var(--nw-radius-lg);background:var(--nw-surface)}
.studio-rich .ProseMirror figure.is-uploading{min-height:120px;border:1px dashed var(--nw-border);border-radius:var(--nw-radius-lg);background:var(--nw-surface)}
.studio-rich .ProseMirror figure.is-linked img{outline:2px dashed var(--nw-accent-soft);outline-offset:2px}
.studio-rich .studio-rich-busy{position:absolute;inset:0 0 auto;display:grid;place-items:center;min-height:120px;color:var(--nw-text-sub);font-size:13px}
.studio-rich .ProseMirror figcaption{min-height:1.6em;padding:6px 0 0;color:var(--nw-text-sub);font-size:13px;text-align:center}
.studio-rich .ProseMirror figcaption:empty::before{content:"画像の説明（任意）";color:var(--nw-text-sub);opacity:.7}
.studio-rich .ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);float:left;height:0;color:var(--nw-text-sub);opacity:.8;pointer-events:none}
.studio-rich .studio-rich-embed{margin:1.2em 0;padding:14px 16px;border:1px dashed var(--nw-border-strong);border-radius:var(--nw-radius-lg);background:var(--nw-surface);color:var(--nw-text-sub);font-size:13px;line-height:1.6}
.studio-rich .studio-rich-toc{margin:1.2em 0;padding:14px 18px;border-radius:var(--nw-radius-lg);background:var(--nw-surface);font-size:13px;line-height:1.7}
.studio-rich .studio-rich-toc b{display:block;margin-bottom:4px;font-size:12px;color:var(--nw-text-sub)}
.studio-rich .studio-rich-toc ul{margin:0;padding-left:18px}
.studio-rich .studio-rich-toc .lv3,.studio-rich .studio-rich-toc .lv4{margin-left:14px}
.studio-rich .studio-rich-inline-image{display:inline-block;max-width:100%;height:auto;vertical-align:bottom}
.nw-collection .cw-rich.studio-rich{overflow:visible}
.studio-rich>.cw-rich-tools{border-radius:var(--nw-radius-lg) var(--nw-radius-lg) 0 0}
@media (min-width:720px){.studio-rich>.cw-rich-tools{position:sticky;top:calc(var(--niho-sticky-top,0px) + 57px);z-index:3}}
.studio-rich .cw-tool[aria-pressed=true]{background:var(--nw-accent-soft);color:var(--nw-accent)}
.studio-rich .cw-tool [data-tool=bold]{font-weight:800}
.studio-rich .cw-tool [data-tool=italic]{font-family:Georgia,serif;font-style:italic}
.studio-rich .studio-rich-embed-form{align-items:flex-start}
.studio-rich .studio-rich-embed-form label{flex-basis:100%;font-size:12px;color:var(--nw-text-sub)}
.studio-rich .studio-rich-embed-form textarea{flex:1 1 100%;min-height:96px;font:12px/1.5 var(--nw-font-mono)}
.studio-rich>.cw-hint,.studio-rich>.cw-error{margin:0;padding:6px 12px 8px}
@media (max-width:600px){.studio-rich .ProseMirror{padding:12px 14px 22px;min-height:240px}}
@media (prefers-reduced-motion:reduce){.studio-rich .ProseMirror-gapcursor:after{animation:none}}
`;
