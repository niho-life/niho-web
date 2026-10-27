import { uiTokensCss } from "./ui-tokens.js";

export const siteLanguageSettingsCss = `${uiTokensCss}.nw-language-settings{max-width:760px;padding:28px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg);background:var(--nw-bg);color:var(--nw-text);font:var(--nw-font-size)/1.6 var(--nw-font)}
.nw-language-settings h3{margin:0;font-size:18px;letter-spacing:-.02em}.nw-language-settings p{margin:7px 0 0;color:var(--nw-text-sub);line-height:1.65}
.nw-language-settings fieldset{border:0;padding:0;margin:24px 0 0}.nw-language-settings legend{font-size:13px;font-weight:700;color:var(--nw-text)}
.nw-language-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}
.nw-language-option{display:flex;align-items:center;gap:11px;min-height:62px;padding:15px 17px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-lg);cursor:pointer;font-weight:700;transition:border-color .15s,background .15s}
.nw-language-option:has(input:checked){border-color:var(--nw-accent-border);background:var(--nw-accent-soft)}.nw-language-option:has(input:focus-visible){outline:2px solid var(--nw-focus);outline-offset:2px}
.nw-language-option:has(input:disabled){cursor:default}.nw-language-option input{width:17px;height:17px;margin:0;accent-color:var(--nw-accent)}
.nw-language-direction{display:flex;align-items:center;gap:12px;margin-top:20px;color:var(--nw-text-sub)}.nw-language-direction strong{color:var(--nw-text)}.nw-language-direction b{font-size:17px;font-weight:400;color:var(--nw-text-faint)}
.nw-language-note{font-size:12px}.nw-language-actions{display:flex;align-items:center;gap:16px;margin-top:20px}
.nw-language-actions button{border:0;border-radius:var(--nw-radius);padding:10px 18px;background:var(--nw-accent);color:var(--nw-on-accent);font:inherit;font-weight:700;cursor:pointer}.nw-language-actions button:disabled{opacity:.5;cursor:default}
.nw-language-settings [role=alert]{color:var(--nw-danger)}.nw-language-settings [role=status]{color:var(--nw-text-sub)}
@media(max-width:560px){.nw-language-settings{padding:22px}.nw-language-options{grid-template-columns:1fr}}
`;
