import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = mkdtempSync(path.join(os.tmpdir(), "editor-fragment-shortcuts-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
  entryPoints: {
    fragment: fileURLToPath(new URL("../src/editor-fragment.ts", import.meta.url)),
    shortcuts: fileURLToPath(new URL("../src/editor-shortcuts.ts", import.meta.url)),
  },
  bundle: true, format: "esm", platform: "node", target: "node22", outdir: directory, logLevel: "silent"
});
const { parseEditorNodeClipboard } = await import(pathToFileURL(path.join(directory, "fragment.js")).href);
const { dispatchEditorShortcut, editorShortcuts } = await import(pathToFileURL(path.join(directory, "shortcuts.js")).href);

test("clipboard validation checks each root node at depth zero", () => {
  const nodes = Array.from({ length: 60 }, (_, index) => ({ type: "element", id: `node${index}`, tag: "div", attrs: {}, children: [] }));
  const parsed = parseEditorNodeClipboard({ version: 1, siteId: "demo", nodes, tokenNames: [], textStyleNames: [], assets: [] });
  assert.equal(parsed.nodes.length, 60);
});

test("Option-Command-V matches the physical V key when Option transforms the character", () => {
  let action = null;
  const commands = Object.fromEntries(editorShortcuts.map(({ action: name }) => [name, { run: () => { action = name; return true; } }]));
  const event = {
    defaultPrevented: false, isComposing: false, keyCode: 0, key: "√", code: "KeyV",
    metaKey: true, ctrlKey: false, shiftKey: false, altKey: true,
    composedPath: () => [], getModifierState: () => false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}
  };

  dispatchEditorShortcut(event, false, () => undefined, commands, () => {});
  assert.equal(action, "pasteInside");
  assert.equal(event.defaultPrevented, true);
});
