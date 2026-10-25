/**
 * Studio の本文（richText）の編集部品。CollectionWorkspace の renderRichText に渡す。
 * 鎌倉の管理画面と同じ TipTap の拡張（./rich-text-schema.ts）で、STUDIO から移した本文の書式を保つ。
 *
 * - 値は HTML の文字列。読み込んだだけでは onChange を呼ばない（値を書き換えない）。
 * - 直すと、変わった段だけを書き出し、前後の変わっていない段は元の HTML のまま返す。元に戻すと読み込んだ値を返す。
 * - 無害化は共有の sanitize（props.sanitize）ではなく、STUDIO の書式を残す Studio の許可リスト（./rich-text-sanitize.ts）。
 *   画像の "/" から始まる path を残すかは、props.sanitize（＝ adapter.isRichTextImageAllowed）に合わせる。
 * - inline の <style> を使わない（Studio の CSP）。見た目は studioRichTextCss（build で assets/studio.css に足す）。
 */
import { Editor } from "@tiptap/core";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { CollectionRichTextEditorProps } from "../src/collection-fields.js";
import { createBaseline, createRichTextExtensions, randomId, serializeRichText, type RichTextBaseline } from "./rich-text-schema.js";
import { isStudioRichTextSafe, sanitizeStudioRichTextHtml, studioRichTextHref, studioRichTextImageSrc, type StudioRichTextSanitizeOptions } from "./rich-text-sanitize.js";

export type StudioRichTextOptions = {
  /** 編集画面で本文の画像を出すときの URL（ホストの adapter.imageUrl など。width は 1200）。無ければ src のまま。 */
  readonly imageUrl?: (url: string, width: number) => string;
};

/** CollectionWorkspace の renderRichText に渡す関数を作る。 */
export function createStudioRichText(options: StudioRichTextOptions = {}): (props: CollectionRichTextEditorProps) => ReactNode {
  return (props) => <StudioRichTextEditor {...props} options={options} />;
}

type Status = { readonly text: string; readonly error: boolean };
type Session = { readonly editor: Editor; readonly baseline: RichTextBaseline; readonly sanitize: (html: string) => string };
const PLACEHOLDER = "本文を入力します。画像はここへドラッグしても入れられます。";
const NOT_IMAGE = "画像ではないファイルは入れられません。画像（JPEG・PNG・WebP など）を選んでください。";

export function StudioRichTextEditor(props: CollectionRichTextEditorProps & { readonly options?: StudioRichTextOptions }) {
  const { id, invalid, value } = props;
  const latest = useRef(props);
  latest.current = props;
  const mount = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null), linkInput = useRef<HTMLInputElement>(null);
  const session = useRef<Session | null>(null), emitted = useRef<string | null>(null);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [panel, setPanel] = useState<null | { kind: "link"; url: string; error: string } | { kind: "embed"; code: string; error: string }>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const sanitizeOptions: StudioRichTextSanitizeOptions = {
    // "/" から始まる画像は、ワークスペースの sanitize（adapter.isRichTextImageAllowed）が残すものだけ
    isImageSrcAllowed: (src) => latest.current.sanitize(`<img src="${src}" alt="">`).includes("<img"),
  };
  const emit = () => {
    const current = session.current;
    if (!current) return;
    const html = serializeRichText(current.editor.state.doc, current.baseline, current.editor.schema, current.sanitize);
    if (html === emitted.current) return;
    emitted.current = html;
    latest.current.onChange(html);
  };

  const insertFiles = (files: readonly File[], at: number | null) => {
    const editor = session.current?.editor;
    if (!editor) return;
    const images = files.filter((chosen) => /^image\//u.test(chosen.type));
    if (images.length < files.length) setStatus({ text: NOT_IMAGE, error: true });
    if (!images.length) return;
    setStatus({ text: "画像を上げています…", error: false });
    const $pos = editor.state.doc.resolve(Math.min(at ?? editor.state.selection.to, editor.state.doc.content.size));
    let position = $pos.depth ? $pos.after(1) : $pos.pos;
    const tokens = images.map((chosen) => {
      const token = randomId(12);
      editor.chain().insertContentAt(position, { type: "figure", attrs: { src: null, alt: "", width: "", height: "", style: "", uploading: token } }).run();
      position = Math.min(position + (editor.state.doc.nodeAt(position)?.nodeSize ?? 0), editor.state.doc.content.size);
      return { chosen, token };
    });
    const find = (token: string) => {
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => { if (node.type.name === "figure" && node.attrs.uploading === token) found = pos; return found === null; });
      return found as number | null;
    };
    void Promise.all(tokens.map(async ({ chosen, token }) => {
      let result: Awaited<ReturnType<CollectionRichTextEditorProps["uploadImage"]>>;
      try { result = await latest.current.uploadImage(chosen); } catch { result = { error: "画像を上げられませんでした。もう一度試してください。" }; }
      if (editor.isDestroyed) return null;
      const pos = find(token);
      if (pos === null) return null; // 上げている間に消された
      const node = editor.state.doc.nodeAt(pos)!;
      const url = "url" in result ? studioRichTextImageSrc(result.url, sanitizeOptions) : null;
      if (!("url" in result) || url === null) {
        editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
        return "url" in result ? "この画像は本文に入れられません。" : result.error;
      }
      const size = (value: number | undefined) => value && Number.isFinite(value) ? String(Math.round(value)) : "";
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: url, width: size(result.width), height: size(result.height), uploading: null }));
      return null;
    })).then((errors) => {
      const error = errors.find((message): message is string => !!message);
      setStatus(error ? { text: error, error: true } : null);
    });
  };

  // 値が外から変わったとき（項目を開いた・ほかの人の版を読み直した）だけ、本文を作り直す。
  // 親が描き直す前に古い value のまま描かれても作り直さないよう、value が変わったときだけ見る
  useEffect(() => {
    const element = mount.current;
    if (!element || (session.current && value === emitted.current)) return;
    session.current?.editor.destroy();
    setPanel(null);
    const hostSanitize = (html: string) => sanitizeStudioRichTextHtml(html, sanitizeOptions);
    // 出すのは本文に残せる画像だけ。ホストの imageUrl で変えた後も https か同じサイトの path であること
    const display = (src: string) => {
      const allowed = studioRichTextImageSrc(src, sanitizeOptions);
      if (allowed === null) return null;
      const transform = latest.current.options?.imageUrl;
      try { const shown = transform ? transform(allowed, 1200) : allowed; return studioRichTextImageSrc(shown, { isImageSrcAllowed: () => true }); } catch { return null; }
    };
    const editor = new Editor({
      element,
      content: value,
      injectCSS: false,
      extensions: createRichTextExtensions({ displayImage: display, sanitize: hostSanitize, placeholder: PLACEHOLDER }),
      editorProps: {
        attributes: () => {
          const current = latest.current;
          return {
            id: current.id, class: "studio-rich-body", "aria-multiline": "true", "aria-labelledby": current.labelId,
            ...(current.describedBy ? { "aria-describedby": current.describedBy } : {}),
            ...(current.invalid ? { "aria-invalid": "true" } : {}),
          };
        },
        transformPastedHTML: (html) => hostSanitize(html),
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (moved || !files.length) return false;
          event.preventDefault();
          insertFiles(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
          return true;
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length) return false;
          insertFiles(files, null);
          return true;
        },
      },
      onUpdate: ({ transaction }) => { if (transaction.docChanged) emit(); },
      onTransaction: () => refresh(),
    });
    const baseline = createBaseline(value, editor.state.doc, editor.schema, hostSanitize, (html) => isStudioRichTextSafe(html, sanitizeOptions));
    session.current = { editor, baseline, sanitize: hostSanitize };
    emitted.current = value;
    refresh();
  }, [value]);
  useEffect(() => () => { session.current?.editor.destroy(); session.current = null; }, []);
  // ラベル・説明・エラーの属性を付け直す
  useEffect(() => {
    const editor = session.current?.editor;
    if (editor && !editor.isDestroyed) editor.view.updateState(editor.view.state);
  }, [id, props.labelId, props.describedBy, invalid]);
  useEffect(() => { if (panel?.kind === "link") linkInput.current?.focus(); }, [panel?.kind]);

  const editor = session.current?.editor ?? null;
  const chain = () => editor!.chain().focus();
  const active = (name: string, attributes?: Record<string, unknown>) => !!editor && !editor.isDestroyed && editor.isActive(name, attributes);
  const toText = () => {
    let next = chain();
    if (editor!.isActive("bulletList") || editor!.isActive("orderedList")) next = next.liftListItem("listItem");
    if (editor!.isActive("blockquote")) next = next.lift("blockquote");
    next.setParagraph().run();
  };
  const hasToc = () => { let found = false; editor?.state.doc.descendants((node) => { if (node.type.name === "toc") found = true; return !found; }); return found; };
  const tools: readonly { id: string; label: string; short: string; pressed?: boolean; run: () => void }[] = [
    { id: "paragraph", label: "本文", short: "本文", run: toText },
    { id: "h2", label: "見出し", short: "見出し", pressed: active("heading", { level: 2 }), run: () => chain().toggleHeading({ level: 2 }).run() },
    { id: "h3", label: "小見出し", short: "小見出し", pressed: active("heading", { level: 3 }), run: () => chain().toggleHeading({ level: 3 }).run() },
    { id: "bold", label: "太字", short: "B", pressed: active("bold"), run: () => chain().toggleBold().run() },
    { id: "italic", label: "斜体", short: "I", pressed: active("italic"), run: () => chain().toggleItalic().run() },
    { id: "ul", label: "箇条書き", short: "・", pressed: active("bulletList"), run: () => chain().toggleBulletList().run() },
    { id: "ol", label: "番号付き", short: "1.", pressed: active("orderedList"), run: () => chain().toggleOrderedList().run() },
    { id: "quote", label: "引用", short: "引用", pressed: active("blockquote"), run: () => chain().toggleBlockquote().run() },
    { id: "hr", label: "区切り線", short: "線", run: () => chain().setHorizontalRule().run() },
    { id: "toc", label: "目次", short: "目次", run: () => { if (hasToc()) setStatus({ text: "目次は 1 つだけです。すでに入っています。", error: false }); else chain().insertContent({ type: "toc" }).run(); } },
  ];

  const openLink = () => {
    if (!editor) return;
    if (panel?.kind === "link") { setPanel(null); return; }
    if (editor.state.selection.empty && !editor.isActive("link")) { setStatus({ text: "リンクにする文字を先に選んでください。", error: false }); return; }
    setStatus(null);
    setPanel({ kind: "link", url: String(editor.getAttributes("link").href ?? ""), error: "" });
  };
  const applyLink = () => {
    if (!editor || panel?.kind !== "link") return;
    const href = studioRichTextHref(panel.url);
    if (href === null) { setPanel({ ...panel, error: "https:// か mailto: か / か # から始まるアドレスを入力してください。" }); return; }
    const external = /^https?:/iu.test(href);
    chain().extendMarkRange("link").setLink({ href, target: external ? "_blank" : null, rel: external ? "noopener" : null }).run();
    setPanel(null);
  };
  const removeLink = () => { if (editor) chain().extendMarkRange("link").unsetLink().run(); setPanel(null); };
  const applyEmbed = () => {
    if (!editor || panel?.kind !== "embed") return;
    const code = panel.code.trim();
    const html = sanitizeStudioRichTextHtml(`<div data-type="embed_code">${code}</div>`, sanitizeOptions);
    const box = document.createElement("template");
    box.innerHTML = html;
    const embed = box.content.firstElementChild;
    if (!code || !embed || (!embed.childElementCount && !embed.textContent?.trim())) { setPanel({ ...panel, error: "入れられるものがありませんでした。iframe や blockquote から始まる埋め込みのコードを貼ってください。" }); return; }
    chain().insertContent({ type: "rawBlock", attrs: { html } }).run();
    setPanel(null);
    setStatus(/<script\b/iu.test(code) ? { text: "埋め込みを入れました。コードの中の <script> は入れていません。", error: false } : null);
  };

  return <div className={`cw-rich studio-rich${invalid ? " cw-invalid" : ""}`}>
    <div className="cw-rich-tools" role="toolbar" aria-label="本文の書式" aria-controls={id}>
      {tools.map((tool) => <button key={tool.id} type="button" className="cw-tool" aria-label={tool.label} title={tool.label} disabled={!editor}
        {...(tool.pressed === undefined ? {} : { "aria-pressed": tool.pressed })} onMouseDown={(event) => event.preventDefault()} onClick={tool.run}>
        <span aria-hidden="true" data-tool={tool.id}>{tool.short}</span></button>)}
      <button type="button" className="cw-tool" aria-label="リンク" title="リンク" disabled={!editor} aria-pressed={active("link")} aria-expanded={panel?.kind === "link"} onMouseDown={(event) => event.preventDefault()} onClick={openLink}><span aria-hidden="true">リンク</span></button>
      <button type="button" className="cw-tool" aria-label="画像を入れる" title="画像を入れる" disabled={!editor} onMouseDown={(event) => event.preventDefault()} onClick={() => file.current?.click()}><span aria-hidden="true">画像</span></button>
      <button type="button" className="cw-tool" aria-label="埋め込みを入れる" title="埋め込みを入れる" disabled={!editor} aria-expanded={panel?.kind === "embed"} onMouseDown={(event) => event.preventDefault()}
        onClick={() => setPanel(panel?.kind === "embed" ? null : { kind: "embed", code: "", error: "" })}><span aria-hidden="true">埋め込み</span></button>
      <input ref={file} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-label="本文に入れる画像" onChange={(event) => { const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; insertFiles(chosen, null); }} />
    </div>
    {panel?.kind === "link" && <div className="cw-rich-link">
      <label className="cw-sr" htmlFor={`${id}-link`}>リンク先</label>
      <input ref={linkInput} id={`${id}-link`} type="text" inputMode="url" className="cw-input" value={panel.url} placeholder="https://" autoComplete="off" aria-invalid={panel.error ? true : undefined} aria-describedby={panel.error ? `${id}-link-error` : undefined}
        onChange={(event) => setPanel({ ...panel, url: event.target.value, error: "" })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); applyLink(); }
          if (event.key === "Escape") { event.preventDefault(); setPanel(null); editor?.commands.focus(); }
        }} />
      <button type="button" className="cw-button cw-primary" onClick={applyLink}>リンクにする</button>
      <button type="button" className="cw-button" onClick={removeLink}>リンクを外す</button>
      {panel.error && <p className="cw-error" id={`${id}-link-error`}>{panel.error}</p>}
    </div>}
    {panel?.kind === "embed" && <div className="cw-rich-link studio-rich-embed-form">
      <label htmlFor={`${id}-embed`}>埋め込みのコード（Instagram・YouTube・Google マップなどの「埋め込み」で出るもの）</label>
      <textarea id={`${id}-embed`} className="cw-input" rows={4} value={panel.code} spellCheck={false} aria-invalid={panel.error ? true : undefined} aria-describedby={panel.error ? `${id}-embed-error` : undefined}
        onChange={(event) => setPanel({ ...panel, code: event.target.value, error: "" })}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setPanel(null); editor?.commands.focus(); } }} />
      <button type="button" className="cw-button cw-primary" onClick={applyEmbed}>入れる</button>
      <button type="button" className="cw-button" onClick={() => setPanel(null)}>やめる</button>
      {panel.error && <p className="cw-error" id={`${id}-embed-error`}>{panel.error}</p>}
    </div>}
    <div ref={mount} className="studio-rich-mount" />
    {status && <p className={status.error ? "cw-error" : "cw-hint"} role={status.error ? "alert" : "status"}>{status.text}</p>}
  </div>;
}
