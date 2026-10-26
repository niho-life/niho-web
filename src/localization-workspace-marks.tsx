"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { textSegments, type MarkSegment } from "./localization-workspace-model.js";

/** 札の見た目の文字と、読み上げ・title に使う名前。 */
export type MarkDescriber = (segment: Extract<MarkSegment, { type: "mark" }>) => { readonly text: string; readonly name: string };

/** 印の名前から札の文字を作る。open は「〔名前」、close は「名前〕」。 */
export function describeMark(label: string, edge: "single" | "open" | "close", single = "印"): { text: string; name: string } {
  if (edge === "open") return { text: `〔${label}`, name: `${label}の始まり` };
  if (edge === "close") return { text: `${label}〕`, name: `${label}の終わり` };
  return { text: label, name: `${single}「${label}」` };
}

/** 読むだけの表示（原文・翻訳案・前の原文）。印は札で出す。 */
export function MarkedText({ segments, describe, className }: { segments: readonly MarkSegment[]; describe: MarkDescriber; className?: string }) {
  return <span className={`lw-text${className ? ` ${className}` : ""}`}>{segments.map((segment, index) => {
    if (segment.type === "text") return <span key={index}>{segment.text}</span>;
    const { text, name } = describe(segment);
    return <span key={index} className="lw-mark" data-edge={segment.edge} title={name}><span aria-hidden="true">{text}</span><span className="cw-sr">{name}</span></span>;
  })}</span>;
}

const CLIP_TYPE = "application/x-niho-marked-text+json";

function chip(doc: Document, segment: Extract<MarkSegment, { type: "mark" }>, describe: MarkDescriber): HTMLSpanElement {
  const span = doc.createElement("span");
  const { text, name } = describe(segment);
  span.className = "lw-mark";
  span.setAttribute("contenteditable", "false");
  span.setAttribute("data-mark", segment.id);
  span.setAttribute("data-edge", segment.edge);
  span.setAttribute("aria-label", name);
  span.setAttribute("draggable", "false");
  span.title = name;
  span.textContent = text;
  return span;
}
function nodesFor(doc: Document, segments: readonly MarkSegment[], describe: MarkDescriber): Node[] {
  return segments.map((segment) => segment.type === "text" ? doc.createTextNode(segment.text) : chip(doc, segment, describe));
}
const isChip = (node: Node | null | undefined): node is HTMLElement => !!node && node.nodeType === 1 && (node as Element).hasAttribute("data-mark");

/** 編集する要素の中身を、文字と札の並びに読む。 */
export function readMarkedDom(root: Node, singleLine: boolean): MarkSegment[] {
  const out: MarkSegment[] = [];
  const pushText = (text: string) => {
    const value = singleLine ? text.replace(/[\r\n]+/gu, " ") : text;
    if (!value) return;
    const last = out.at(-1);
    if (last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + value };
    else out.push({ type: "text", text: value });
  };
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { pushText(child.textContent ?? ""); return; }
      if (child.nodeType !== 1) return;
      const element = child as Element, tag = element.localName.toLowerCase();
      const id = element.getAttribute("data-mark"), edge = element.getAttribute("data-edge");
      if (id !== null && (edge === "single" || edge === "open" || edge === "close")) { out.push({ type: "mark", id, edge }); return; }
      if (tag === "br") { pushText("\n"); return; }
      if (tag === "div" || tag === "p") { if (out.length) pushText("\n"); walk(element); return; }
      walk(element);
    });
  };
  walk(root);
  return out;
}

export type MarkedTextInputProps = {
  readonly id: string;
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly invalid: boolean;
  readonly readOnly: boolean;
  readonly singleLine: boolean;
  readonly segments: readonly MarkSegment[];
  /** 変わったときだけ、segments で中身を作り直す（入力中の caret を動かさないため）。 */
  readonly renderKey: number;
  readonly describe: MarkDescriber;
  readonly onChange: (segments: MarkSegment[]) => void;
  /** 札を消そうとしたとき（消させない）。 */
  readonly onProtected: () => void;
};

/**
 * 札（置き換えてはいけない印）を消せない入力。中身は contenteditable で、札は contenteditable=false の span。
 * Backspace・Delete・選んで上書きでは札を消せず、切り取り・貼り付けでだけ動かせる。貼り付けは文字（と札）だけ。
 */
export function MarkedTextInput(props: MarkedTextInputProps) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.replaceChildren(...nodesFor(element.ownerDocument, props.segments, props.describe));
    // renderKey が変わったときだけ作り直す
  }, [props.renderKey]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const doc = element.ownerDocument, win = doc.defaultView;
    const selectionRange = (): Range | null => {
      const selection = win?.getSelection();
      if (!selection || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      return element.contains(range.commonAncestorContainer) ? range : null;
    };
    const emit = () => latest.current.onChange(readMarkedDom(element, latest.current.singleLine));
    const rangeHasChip = (range: Range) => Array.from(element.querySelectorAll("[data-mark]")).some((node) => range.intersectsNode(node));
    const insert = (nodes: Node[]) => {
      let range = selectionRange();
      if (!range) { range = doc.createRange(); range.selectNodeContents(element); range.collapse(false); }
      range.deleteContents();
      const last = nodes.at(-1);
      const fragment = doc.createDocumentFragment();
      nodes.forEach((node) => fragment.append(node));
      range.insertNode(fragment);
      if (last) {
        const after = doc.createRange();
        after.setStartAfter(last);
        after.collapse(true);
        const selection = win?.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(after);
      }
      emit();
    };
    const neighbor = (range: Range, backward: boolean): Node | null => {
      const { startContainer: container, startOffset: offset } = range;
      if (container.nodeType === 3) {
        const length = container.textContent?.length ?? 0;
        if (backward ? offset > 0 : offset < length) return null;
        let node: Node | null = backward ? container.previousSibling : container.nextSibling;
        while (node && node.nodeType === 3 && !(node.textContent ?? "")) node = backward ? node.previousSibling : node.nextSibling;
        return node;
      }
      return container.childNodes[backward ? offset - 1 : offset] ?? null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (latest.current.readOnly) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (!latest.current.singleLine && !event.isComposing) insert([doc.createTextNode("\n")]);
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const range = selectionRange();
      if (!range) return;
      if (range.collapsed ? isChip(neighbor(range, event.key === "Backspace")) : rangeHasChip(range)) {
        event.preventDefault();
        latest.current.onProtected();
      }
    };
    const onBeforeInput = (event: InputEvent) => {
      if (latest.current.readOnly) { event.preventDefault(); return; }
      const range = selectionRange();
      if (!range || range.collapsed || event.inputType === "deleteByCut" || event.inputType === "insertFromPaste") return;
      if (rangeHasChip(range)) { event.preventDefault(); latest.current.onProtected(); }
    };
    const onInput = () => { if (!latest.current.readOnly) emit(); };
    const copy = (event: ClipboardEvent, cut: boolean) => {
      const range = selectionRange();
      if (!range || range.collapsed || !event.clipboardData) return;
      event.preventDefault();
      const holder = doc.createElement("div");
      holder.append(range.cloneContents());
      const segments = readMarkedDom(holder, latest.current.singleLine);
      event.clipboardData.setData("text/plain", segments.map((segment) => segment.type === "text" ? segment.text : latest.current.describe(segment).text).join(""));
      event.clipboardData.setData(CLIP_TYPE, JSON.stringify(segments));
      if (cut && !latest.current.readOnly) { range.deleteContents(); emit(); }
    };
    const onCopy = (event: ClipboardEvent) => copy(event, false);
    const onCut = (event: ClipboardEvent) => copy(event, true);
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      if (latest.current.readOnly || !event.clipboardData) return;
      let segments: MarkSegment[] | null = null;
      try {
        const raw = event.clipboardData.getData(CLIP_TYPE);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length <= 2000 && parsed.every((entry) => entry && typeof entry === "object" && (
            (entry.type === "text" && typeof entry.text === "string") || (entry.type === "mark" && typeof entry.id === "string" && /^[A-Za-z0-9_.-]{1,300}$/u.test(entry.id) && ["single", "open", "close"].includes(entry.edge))))) {
            segments = parsed as MarkSegment[];
          }
        }
      } catch { segments = null; }
      if (!segments) {
        const text = event.clipboardData.getData("text/plain");
        segments = textSegments(latest.current.singleLine ? text.replace(/[\r\n]+/gu, " ") : text.replace(/\r\n?/gu, "\n"));
      }
      insert(nodesFor(doc, segments, latest.current.describe));
    };
    const onDrop = (event: DragEvent) => event.preventDefault();
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("beforeinput", onBeforeInput);
    element.addEventListener("input", onInput);
    element.addEventListener("copy", onCopy);
    element.addEventListener("cut", onCut);
    element.addEventListener("paste", onPaste);
    element.addEventListener("drop", onDrop);
    element.addEventListener("dragstart", onDrop);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("beforeinput", onBeforeInput);
      element.removeEventListener("input", onInput);
      element.removeEventListener("copy", onCopy);
      element.removeEventListener("cut", onCut);
      element.removeEventListener("paste", onPaste);
      element.removeEventListener("drop", onDrop);
      element.removeEventListener("dragstart", onDrop);
    };
  }, []);

  return <div ref={ref} id={props.id} className="lw-input" role="textbox" aria-multiline={!props.singleLine} aria-labelledby={props.labelledBy}
    aria-describedby={props.describedBy} aria-invalid={props.invalid || undefined} aria-readonly={props.readOnly || undefined}
    contentEditable={!props.readOnly} suppressContentEditableWarning tabIndex={0} spellCheck data-single-line={props.singleLine || undefined} />;
}
