"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  collectionDateFromInput, collectionDateInputValue, isDisplayableImageUrl, isRichTextLinkAllowed,
  type CollectionField, type CollectionItemSummary, type CollectionUploadRejectReason, type CollectionValue,
} from "./collection-model.js";
import { Icon, zoneLabel } from "./collection-ui.js";

/** ホストがリッチテキストの編集部品を差し替えるときに受け取るもの。 */
export type CollectionRichTextEditorProps = {
  /** 編集する要素の id（ラベルの htmlFor・公開前の focus に使う）。 */
  readonly id: string;
  readonly labelId: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly value: string;
  /** 変更のたびに呼ぶ。HTML は sanitize を通してから渡す。 */
  readonly onChange: (html: string) => void;
  readonly sanitize: (html: string) => string;
  /** 本文に入れる画像を上げる。だめなら error に理由の文。 */
  readonly uploadImage: (file: File) => Promise<{ readonly url: string; readonly width?: number; readonly height?: number } | { readonly error: string }>;
};

export const rejectMessages: Record<CollectionUploadRejectReason | "failed", string> = {
  type: "この種類のファイルは使えません。画像（JPEG・PNG・WebP など）を選んでください。",
  size: "画像が大きすぎます。小さくしてから選び直してください。",
  permission: "画像を上げる権限がありません。",
  invalid: "画像を読み込めませんでした。別の画像を選んでください。",
  failed: "画像を上げられませんでした。もう一度試してください。",
};

export type ReferenceCandidates =
  | { readonly status: "loading" | "error" | "forbidden" }
  | { readonly status: "ready"; readonly items: readonly CollectionItemSummary[] };

export type FieldContext = {
  readonly baseId: string;
  readonly timeZone: string;
  readonly pathPrefix: string | null;
  readonly isTitle: boolean;
  /** 公開中のアドレスの slug（変えると警告を出す）。 */
  readonly publishedSlug: string | null;
  /** 開いている項目（参照の候補から自分を外す）。 */
  readonly self: { readonly collectionId: string; readonly itemId: string };
  readonly imageSrc: (url: string, width: number) => string | null;
  readonly upload: (file: File) => Promise<{ url: string; width?: number; height?: number } | { error: string }>;
  readonly references: (collectionId: string) => ReferenceCandidates;
  readonly retryReferences: (collectionId: string) => void;
  readonly renderRichText: ((props: CollectionRichTextEditorProps) => ReactNode) | undefined;
  readonly sanitize: (html: string) => string;
};

const idFor = (context: FieldContext, field: CollectionField, part: string) => `${context.baseId}-${field.key}-${part}`;
/** 項目の入力の id（公開前の focus に使う）。 */
export const fieldControlId = (baseId: string, key: string) => `${baseId}-${key}-control`;
const asString = (value: CollectionValue | undefined) => typeof value === "string" ? value : "";
const asList = (value: CollectionValue | undefined): readonly string[] => Array.isArray(value) ? value : [];

export function FieldView({ field, value, error, context, onChange }: {
  field: CollectionField; value: CollectionValue | undefined; error: string | undefined; context: FieldContext; onChange: (value: CollectionValue) => void;
}) {
  const controlId = fieldControlId(context.baseId, field.key), labelId = idFor(context, field, "label");
  const hintId = idFor(context, field, "hint"), errorId = idFor(context, field, "error"), extraId = idFor(context, field, "extra");
  const extra = field.type === "slug" ? "半角の英数字・ハイフン・アンダースコア。" : field.type === "datetime" ? `${zoneLabel(context.timeZone)}で入力します。` : null;
  const describedBy = [field.hint ? hintId : null, extra ? extraId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const common = { id: controlId, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": field.required ? true : undefined } as const;
  const labelText = <>{field.label}{field.required && <span className="cw-required">（必須）</span>}</>;
  const grouped = field.type === "image" || field.type === "select";
  const label = grouped ? <span className="cw-label" id={labelId}>{labelText}</span>
    : <label className={`cw-label${context.isTitle ? " cw-sr" : ""}`} id={labelId} htmlFor={controlId}>{labelText}</label>;
  let control: ReactNode;
  switch (field.type) {
    case "text": {
      const text = asString(value), length = [...text].length;
      control = <>
        <input {...common} type="text" className={context.isTitle ? "cw-input cw-title-input" : "cw-input"} value={text} placeholder={context.isTitle ? field.placeholder ?? field.label : field.placeholder} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
        {field.maxLength !== undefined && <span className={`cw-counter${length > field.maxLength ? " cw-over" : ""}`} aria-hidden="true">{length} / {field.maxLength}</span>}
      </>;
      break;
    }
    case "longText": {
      const text = asString(value), length = [...text].length;
      control = <>
        <textarea {...common} className="cw-input cw-textarea" rows={field.rows} value={text} onChange={(event) => onChange(event.target.value)} />
        {field.maxLength !== undefined && <span className={`cw-counter${length > field.maxLength ? " cw-over" : ""}`} aria-hidden="true">{length} / {field.maxLength}</span>}
      </>;
      break;
    }
    case "url":
      control = <input {...common} type="url" className="cw-input" inputMode="url" autoCapitalize="off" spellCheck={false} value={asString(value)} placeholder={field.placeholder ?? "https://"} onChange={(event) => onChange(event.target.value)} />;
      break;
    case "slug": {
      const slug = asString(value);
      control = <>
        <div className="cw-slug">{context.pathPrefix !== null && <span aria-hidden="true">{context.pathPrefix}</span>}
          <input {...common} type="text" className="cw-input" autoCapitalize="off" autoComplete="off" spellCheck={false} value={slug} onChange={(event) => onChange(event.target.value)} />
        </div>
        {context.publishedSlug !== null && slug !== context.publishedSlug && <p className="cw-hint cw-warn">公開中のアドレスを変えると、前のアドレスを開いた人や検索結果からは見つからなくなります。</p>}
      </>;
      break;
    }
    case "datetime": {
      const iso = typeof value === "string" ? value : null;
      control = <div className="cw-inline">
        <input {...common} type="datetime-local" className="cw-input" value={collectionDateInputValue(iso, context.timeZone)} onChange={(event) => onChange(event.target.value ? collectionDateFromInput(event.target.value, context.timeZone) : null)} />
        {iso !== null && <button type="button" className="cw-button" onClick={() => onChange(null)} aria-label={`${field.label}を消す`}>消す</button>}
      </div>;
      break;
    }
    case "richText":
      control = (context.renderRichText ?? ((props: CollectionRichTextEditorProps) => <DefaultRichText {...props} />))({
        id: controlId, labelId, describedBy, invalid: !!error, value: asString(value), onChange: (html) => onChange(html), sanitize: context.sanitize, uploadImage: context.upload,
      });
      break;
    case "image":
      control = <ImageControl field={field} value={typeof value === "string" ? value : null} context={context} controlId={controlId} labelId={labelId} describedBy={describedBy} onChange={onChange} />;
      break;
    case "select":
      control = <SelectControl field={field} value={asList(value)} controlId={controlId} describedBy={describedBy} onChange={onChange} />;
      break;
    case "reference":
      control = <ReferenceControl field={field} value={asList(value)} context={context} controlId={controlId} describedBy={describedBy} invalid={!!error} onChange={onChange} />;
      break;
    case "tags":
      control = <TagsControl field={field} value={asList(value)} controlId={controlId} describedBy={describedBy} invalid={!!error} onChange={onChange} />;
      break;
  }
  const body = <>
    {label}
    {field.hint && <p className="cw-hint" id={hintId}>{field.hint}</p>}
    {control}
    {extra && <p className="cw-hint" id={extraId}>{extra}</p>}
    {error && <p className="cw-error" id={errorId}><Icon name="alert" />{error}</p>}
  </>;
  return grouped
    ? <div className={`cw-field cw-field-${field.type}`} data-field={field.key} role="group" aria-labelledby={labelId}>{body}</div>
    : <div className={`cw-field cw-field-${field.type}${context.isTitle ? " cw-field-title" : ""}`} data-field={field.key}>{body}</div>;
}

/* ---------- 画像 ---------- */

function ImageControl({ field, value, context, controlId, labelId, describedBy, onChange }: {
  field: Extract<CollectionField, { type: "image" }>; value: string | null; context: FieldContext; controlId: string; labelId: string; describedBy: string | undefined; onChange: (value: CollectionValue) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [failed, setFailed] = useState<string | null>(null);
  const src = value !== null ? context.imageSrc(value, 480) : null;
  const pick = async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = "";
    if (!chosen) return;
    setState({ busy: true, error: null });
    const result = await context.upload(chosen);
    if ("url" in result) { setState({ busy: false, error: null }); onChange(result.url); }
    else setState({ busy: false, error: result.error });
  };
  return <div className="cw-image" data-shape={field.shape ?? "rect"} aria-busy={state.busy}>
    <span className="cw-image-preview">{src && src !== failed ? <img src={src} alt={`${field.label}の画像`} referrerPolicy="no-referrer" onError={() => setFailed(src)} /> : <span className="cw-image-empty"><Icon name="image" /><span>{value ? "表示できません" : "画像なし"}</span></span>}</span>
    <span className="cw-image-actions">
      <button id={controlId} type="button" className="cw-button" aria-describedby={describedBy} disabled={state.busy} onClick={() => file.current?.click()}>{state.busy ? "上げています…" : value ? "画像を変える" : "画像を選ぶ"}</button>
      {value !== null && <button type="button" className="cw-button" disabled={state.busy} onClick={() => onChange(null)} aria-label={`${field.label}を外す`}>外す</button>}
      <input ref={file} type="file" accept="image/*" hidden tabIndex={-1} aria-labelledby={labelId} onChange={(event) => void pick(event.currentTarget)} />
    </span>
    {state.busy && <p className="cw-hint" role="status">画像を上げています…</p>}
    {state.error && <p className="cw-error" role="alert"><Icon name="alert" />{state.error}</p>}
  </div>;
}

/* ---------- 選択（1 つ・複数） ---------- */

function SelectControl({ field, value, controlId, describedBy, onChange }: {
  field: Extract<CollectionField, { type: "select" }>; value: readonly string[]; controlId: string; describedBy: string | undefined; onChange: (value: CollectionValue) => void;
}) {
  const unknown = value.filter((id) => !field.options.some((option) => option.id === id)).map((id) => ({ id, label: "（見つからない選択肢）" }));
  const options = [...(field.multiple || field.required ? [] : [{ id: "", label: "なし" }]), ...field.options, ...unknown];
  const name = `${controlId}-name`;
  return <div className="cw-options">
    {options.map((option, index) => {
      const checked = option.id === "" ? value.length === 0 : value.includes(option.id);
      return <label key={option.id || "none"} className="cw-option">
        <input id={index === 0 ? controlId : undefined} type={field.multiple ? "checkbox" : "radio"} name={field.multiple ? undefined : name} value={option.id} checked={checked} aria-describedby={index === 0 ? describedBy : undefined} onChange={(event) => {
          if (!field.multiple) onChange(option.id === "" ? [] : [option.id]);
          else onChange(event.target.checked ? [...value, option.id] : value.filter((id) => id !== option.id));
        }} />
        <span>{option.label}</span>
      </label>;
    })}
  </div>;
}

/* ---------- 参照（ほかのコレクションの項目） ---------- */

function ReferenceControl({ field, value, context, controlId, describedBy, invalid, onChange }: {
  field: Extract<CollectionField, { type: "reference" }>; value: readonly string[]; context: FieldContext; controlId: string; describedBy: string | undefined; invalid: boolean; onChange: (value: CollectionValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const candidates = context.references(field.collectionId);
  const items = candidates.status === "ready" ? candidates.items.filter((item) => !(field.collectionId === context.self.collectionId && item.id === context.self.itemId)) : [];
  const titleOf = (id: string) => {
    const found = candidates.status === "ready" ? candidates.items.find((item) => item.id === id) : undefined;
    return found ? found.title || "無題" : candidates.status === "loading" ? "読み込み中…" : "（見つからない項目）";
  };
  const needle = query.trim().toLocaleLowerCase("ja-JP");
  const matches = items.filter((item) => !value.includes(item.id) && (!needle || item.title.toLocaleLowerCase("ja-JP").includes(needle))).slice(0, 8);
  const listId = `${controlId}-options`;
  const shown = open || !!needle;
  const pick = (id: string) => {
    onChange(field.multiple ? [...value, id] : [id]);
    setQuery("");
    if (!field.multiple) setOpen(false);
  };
  return <div className="cw-reference" ref={container} onBlur={(event) => { if (!container.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    {value.length > 0 && <ul className="cw-chips" aria-label="選んだもの">{value.map((id) => <li key={id} className="cw-chip"><span>{titleOf(id)}</span>
      <button type="button" className="cw-chip-remove" aria-label={`「${titleOf(id)}」を外す`} onClick={() => onChange(value.filter((other) => other !== id))}><Icon name="close" /></button></li>)}</ul>}
    <div className="cw-search cw-reference-search"><Icon name="search" />
      <input id={controlId} type="search" role="combobox" aria-expanded={shown} aria-controls={shown ? listId : undefined} aria-autocomplete="list" aria-describedby={describedBy} aria-invalid={invalid || undefined} value={query} autoComplete="off"
        placeholder={field.multiple || value.length === 0 ? "題名で探して選ぶ" : "題名で探して選び直す"}
        onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setOpen(false); setQuery(""); }
          if (event.key === "Enter" && !event.nativeEvent.isComposing && matches[0]) { event.preventDefault(); pick(matches[0].id); }
        }} />
    </div>
    {shown && <div className="cw-reference-list" id={listId}>
      {candidates.status === "loading" ? <p className="cw-hint" role="status">候補を読み込んでいます…</p>
        : candidates.status === "forbidden" ? <p className="cw-hint" role="alert">候補を見る権限がありません。</p>
        : candidates.status === "error" ? <p className="cw-hint" role="alert">候補を読み込めませんでした。<button type="button" className="cw-link-button" onClick={() => context.retryReferences(field.collectionId)}>もう一度読み込む</button></p>
        : matches.length === 0 ? <p className="cw-hint">{needle ? `「${query.trim()}」に当てはまるものはありません。` : "選べるものはありません。"}</p>
        : <ul className="cw-reference-options" aria-label={`${field.label}の候補`}>{matches.map((item) => <li key={item.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(item.id)}>{item.title || "無題"}</button></li>)}</ul>}
    </div>}
  </div>;
}

/* ---------- タグ ---------- */

function TagsControl({ field, value, controlId, describedBy, invalid, onChange }: {
  field: Extract<CollectionField, { type: "tags" }>; value: readonly string[]; controlId: string; describedBy: string | undefined; invalid: boolean; onChange: (value: CollectionValue) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const tag = draft.trim().replace(/\s+/gu, " ").slice(0, 200);
    setDraft("");
    if (tag && !value.includes(tag)) onChange([...value, tag]);
  };
  return <div className="cw-tags">
    {value.length > 0 && <ul className="cw-chips" aria-label={`${field.label}（${value.length} 件）`}>{value.map((tag) => <li key={tag} className="cw-chip"><span>{tag}</span>
      <button type="button" className="cw-chip-remove" aria-label={`「${tag}」を外す`} onClick={() => onChange(value.filter((other) => other !== tag))}><Icon name="close" /></button></li>)}</ul>}
    <div className="cw-inline">
      <input id={controlId} type="text" className="cw-input" value={draft} placeholder="入力して Enter で足す" autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); add(); } }} />
      <button type="button" className="cw-button" onClick={add} disabled={!draft.trim()}>足す</button>
    </div>
  </div>;
}

/* ---------- 既定のリッチテキスト（contenteditable） ---------- */

type Tool = { readonly id: string; readonly label: string; readonly short: string; readonly command: string; readonly arg?: string };
const tools: readonly Tool[] = [
  { id: "p", label: "段落", short: "段落", command: "formatBlock", arg: "<p>" },
  { id: "h2", label: "見出し", short: "見出し", command: "formatBlock", arg: "<h2>" },
  { id: "h3", label: "小見出し", short: "小見出し", command: "formatBlock", arg: "<h3>" },
  { id: "bold", label: "太字", short: "B", command: "bold" },
  { id: "italic", label: "斜体", short: "I", command: "italic" },
  { id: "ul", label: "箇条書き", short: "・", command: "insertUnorderedList" },
  { id: "ol", label: "番号付き", short: "1.", command: "insertOrderedList" },
  { id: "quote", label: "引用", short: "引用", command: "formatBlock", arg: "<blockquote>" },
];
const canExec = () => typeof document !== "undefined" && typeof (document as Document & { execCommand?: unknown }).execCommand === "function";

/** contenteditable と道具の並び。execCommand が無い環境（jsdom など）では書式の道具は何もしない。 */
export function DefaultRichText({ id, labelId, describedBy, invalid, value, onChange, sanitize, uploadImage }: CollectionRichTextEditorProps) {
  const editor = useRef<HTMLDivElement>(null), emitted = useRef<string | null>(null), saved = useRef<Range | null>(null), file = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState<{ open: boolean; url: string; error: string }>({ open: false, url: "", error: "" });
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    const element = editor.current;
    if (!element || value === emitted.current) return;
    element.innerHTML = sanitize(value);
    emitted.current = value;
  }, [value, sanitize]);
  const emit = () => {
    const element = editor.current;
    if (!element) return;
    const html = sanitize(element.innerHTML);
    emitted.current = html;
    onChange(html);
  };
  const remember = () => {
    const selection = window.getSelection?.();
    if (selection && selection.rangeCount > 0 && editor.current?.contains(selection.anchorNode)) saved.current = selection.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    const selection = window.getSelection?.();
    if (!selection || !saved.current) return;
    selection.removeAllRanges();
    selection.addRange(saved.current);
  };
  const exec = (command: string, arg?: string): boolean => {
    if (!canExec() || !editor.current) return false;
    editor.current.focus();
    restore();
    let done = false;
    try { done = document.execCommand(command, false, arg); } catch { done = false; }
    emit();
    return done;
  };
  const applyLink = () => {
    const url = link.url.trim();
    if (!isRichTextLinkAllowed(url)) { setLink({ ...link, error: "http:// か https:// か mailto: から始まるアドレスを入力してください。" }); return; }
    setLink({ open: false, url: "", error: "" });
    exec("createLink", url);
  };
  const insertImage = async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = "";
    if (!chosen) return;
    setStatus({ text: "画像を上げています…", error: false });
    const result = await uploadImage(chosen);
    if (!("url" in result)) { setStatus({ text: result.error, error: true }); return; }
    if (!sanitize(`<img src="${result.url.replace(/"/gu, "")}" alt="">`)) { setStatus({ text: "この画像は本文に入れられません。", error: true }); return; }
    setStatus(null);
    if (exec("insertImage", result.url)) return;
    // execCommand が無いとき・失敗したときは、本文の最後に段落として足す
    const element = editor.current;
    if (!element) return;
    const paragraph = document.createElement("p"), image = document.createElement("img");
    image.setAttribute("src", result.url);
    image.setAttribute("alt", "");
    if ("width" in result && result.width) image.setAttribute("width", String(result.width));
    if ("height" in result && result.height) image.setAttribute("height", String(result.height));
    paragraph.append(image);
    element.append(paragraph);
    emit();
  };
  return <div className={`cw-rich${invalid ? " cw-invalid" : ""}`}>
    <div className="cw-rich-tools" role="toolbar" aria-label="本文の書式" aria-controls={id}>
      {tools.map((tool) => <button key={tool.id} type="button" className="cw-tool" aria-label={tool.label} title={tool.label} onMouseDown={(event) => event.preventDefault()} onClick={() => exec(tool.command, tool.arg)}><span aria-hidden="true" data-tool={tool.id}>{tool.short}</span></button>)}
      <button type="button" className="cw-tool" aria-label="リンク" title="リンク" aria-expanded={link.open} onMouseDown={(event) => event.preventDefault()} onClick={() => { remember(); setLink({ open: !link.open, url: "", error: "" }); }}><span aria-hidden="true">リンク</span></button>
      <button type="button" className="cw-tool" aria-label="画像を入れる" title="画像を入れる" onMouseDown={(event) => event.preventDefault()} onClick={() => { remember(); file.current?.click(); }}><Icon name="image" /></button>
      <input ref={file} type="file" accept="image/*" hidden tabIndex={-1} aria-label="本文に入れる画像" onChange={(event) => void insertImage(event.currentTarget)} />
    </div>
    {link.open && <div className="cw-rich-link">
      <label className="cw-sr" htmlFor={`${id}-link`}>リンク先</label>
      <input id={`${id}-link`} type="url" className="cw-input" value={link.url} placeholder="https://" autoComplete="off" aria-invalid={link.error ? true : undefined} aria-describedby={link.error ? `${id}-link-error` : undefined}
        onChange={(event) => setLink({ ...link, url: event.target.value, error: "" })}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); applyLink(); } if (event.key === "Escape") { event.preventDefault(); setLink({ open: false, url: "", error: "" }); editor.current?.focus(); } }} />
      <button type="button" className="cw-button cw-primary" onClick={applyLink}>リンクにする</button>
      <button type="button" className="cw-button" onClick={() => { setLink({ open: false, url: "", error: "" }); exec("unlink"); }}>リンクを外す</button>
      {link.error && <p className="cw-error" id={`${id}-link-error`}><Icon name="alert" />{link.error}</p>}
    </div>}
    <div ref={editor} id={id} className="cw-rich-area" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-labelledby={labelId} aria-describedby={describedBy} aria-invalid={invalid || undefined} tabIndex={0}
      onInput={emit}
      onFocus={() => { if (canExec()) { try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* 古いブラウザは無視 */ } } }}
      onPaste={(event) => {
        if (!canExec()) return;
        event.preventDefault();
        const html = event.clipboardData.getData("text/html"), text = event.clipboardData.getData("text/plain");
        if (html) exec("insertHTML", sanitize(html));
        else exec("insertText", text);
      }} />
    {status && <p className={status.error ? "cw-error" : "cw-hint"} role={status.error ? "alert" : "status"}>{status.error && <Icon name="alert" />}{status.text}</p>}
  </div>;
}

/** 画像の表示用の URL を決める（ホストの imageUrl を通し、表示してよい URL だけ）。 */
export function displayImage(url: string | null, width: number, transform: ((url: string, width: number) => string) | undefined): string | null {
  if (url === null || !isDisplayableImageUrl(url)) return null;
  let next = url;
  try { next = transform ? transform(url, width) : url; } catch { return null; }
  return isDisplayableImageUrl(next) ? next : null;
}
