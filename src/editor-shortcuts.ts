type ShortcutResult = boolean | string;
export type ShortcutCommand = { run: (event?: KeyboardEvent) => ShortcutResult; unavailable?: string | undefined };

type Shortcut = {
  action: string;
  label: string;
  keys: readonly string[];
  keyLabel: string;
  command?: true;
  shift?: boolean | "either";
  palette?: true;
  canvasArrows?: true;
};

export const editorShortcuts = [
  { action: "undo", label: "元に戻す", keys: ["z"], keyLabel: "⌘Z / Ctrl+Z", command: true, palette: true },
  { action: "redo", label: "やり直す", keys: ["z"], keyLabel: "⇧⌘Z / Ctrl+Shift+Z", command: true, shift: true, palette: true },
  { action: "remove", label: "削除", keys: ["delete", "backspace"], keyLabel: "Delete / Backspace", palette: true },
  { action: "duplicate", label: "複製", keys: ["d"], keyLabel: "⌘D / Ctrl+D", command: true, palette: true },
  { action: "moveUp", label: "選択要素を上へ", keys: ["arrowup"], keyLabel: "↑（キャンバス）", palette: true, canvasArrows: true },
  { action: "moveDown", label: "選択要素を下へ", keys: ["arrowdown"], keyLabel: "↓（キャンバス）", palette: true, canvasArrows: true },
  { action: "parent", label: "親を選択", keys: ["escape"], keyLabel: "Esc" },
  { action: "child", label: "最初の子を選択・文字を編集", keys: ["enter"], keyLabel: "Enter" },
  { action: "zoomIn", label: "表示倍率を上げる", keys: ["+", "="], keyLabel: "⌘+ / Ctrl++", command: true, shift: "either", palette: true },
  { action: "zoomOut", label: "表示倍率を下げる", keys: ["-"], keyLabel: "⌘− / Ctrl+−", command: true, palette: true },
  { action: "zoomReset", label: "表示倍率を100%に戻す", keys: ["0"], keyLabel: "⌘0 / Ctrl+0", command: true, palette: true },
  { action: "palette", label: "コマンドパレット", keys: ["k"], keyLabel: "⌘K / Ctrl+K", command: true },
  { action: "help", label: "ショートカット一覧", keys: ["?"], keyLabel: "?", shift: "either", palette: true },
] as const satisfies readonly Shortcut[];

export type ShortcutAction = typeof editorShortcuts[number]["action"];

// iframe の Element は親 window の instanceof Element では判定できない。
function eventElement(target: EventTarget | undefined): Element | undefined {
  return target && "nodeType" in target && target.nodeType === 1 ? target as Element : undefined;
}

function matchesShortcut(shortcut: Shortcut, event: KeyboardEvent): boolean {
  return !!shortcut.command === (event.metaKey || event.ctrlKey) &&
    (shortcut.shift === "either" || !!shortcut.shift === event.shiftKey) && shortcut.keys.includes(event.key.toLowerCase());
}

export function dispatchEditorShortcut(event: KeyboardEvent, inCanvas: boolean, blockedReason: (action: ShortcutAction) => string | undefined,
  commands: Record<ShortcutAction, ShortcutCommand>, report: (reason: string) => void): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.getModifierState("AltGraph")) return;
  const elements = event.composedPath().flatMap((item) => { const element = eventElement(item); return element ? [element] : []; });
  if (elements.some((element) => element.matches("input, textarea, select, [role='textbox'], [role='dialog'], [role='alertdialog']"))) return;
  // 開いているローカル操作の Escape を先に処理させる。
  if (event.key === "Escape" && elements.some((element) => element.matches("[role='menu'], .e-asset"))) return;
  const editable = elements.map((element) => element.getAttribute("contenteditable")?.toLowerCase())
    .find((value) => value === "" || value === "true" || value === "false" || value === "plaintext-only");
  if (editable !== undefined && editable !== "false") return;

  if (event.metaKey && event.ctrlKey) return;
  const definition = editorShortcuts.find((shortcut) => matchesShortcut(shortcut, event));
  if (!definition) return;
  if ("canvasArrows" in definition && !inCanvas) return;
  // ボタン等の Enter は通常の操作に使う。選択済みのレイヤー行だけは子を選択する。
  if (definition.action === "child" && elements.some((element) => element.matches("button, a[href], summary, [role='tab'], [role='button']") && !element.matches("[role='treeitem'][aria-selected='true']"))) return;
  const command = commands[definition.action];
  const result = blockedReason(definition.action) ?? command.unavailable ?? command.run(event);
  if (typeof result === "string") report(result);
  else if (result) {
    event.preventDefault();
    event.stopPropagation();
  }
}
