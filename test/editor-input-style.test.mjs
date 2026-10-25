import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PageEditor } from "@niho/web/editor";

/** 編集画面の <style> を順に返す。素材 adapter があると 2 つ目に素材パネルの CSS が付く。 */
function stylesheets(props = {}) {
  const html = renderToString(createElement(PageEditor, { adapter: {}, ...props }));
  return [...html.matchAll(/<style>([^]*?)<\/style>/g)].map((match) => match[1]);
}
/** selector{…} の宣言ブロック。最初の一致だけを見る。 */
function block(css, selector) {
  const index = css.indexOf(`${selector}{`);
  assert.notEqual(index, -1, `rule for ${selector}`);
  return css.slice(index + selector.length + 1, css.indexOf("}", index));
}

test("every input kind draws the same neutral surface, border, radius and focus ring from shared tokens", () => {
  const [css] = stylesheets();
  for (const token of ["--e-input:#f2f2f2", "--e-input-border:#e3e3e3", "--e-input-disabled:#e9e9e9", "--e-placeholder:#858585", "--e-unit:#666", "--e-radius:6px", "--e-focus:var(--e-blue)"]) assert.ok(css.includes(token), token);
  const plain = block(css, ".nw-editor input:not([type=checkbox]):not([type=radio]),.nw-editor select,.nw-editor textarea");
  const unit = block(css, ".nw-editor .e-frame"), url = block(css, ".nw-editor .e-field>.e-url-input");
  for (const [name, rule] of Object.entries({ plain, unit, url })) {
    assert.ok(rule.includes("background-color:var(--e-input)"), `${name} surface`);
    assert.ok(rule.includes("border:1px solid var(--e-input-border)"), `${name} border`);
    assert.ok(rule.includes("border-radius:var(--e-radius)"), `${name} radius`);
    assert.ok(rule.includes("min-height:30px"), `${name} height`);
  }
  assert.ok(block(css, ".nw-editor .e-frame:focus-within").includes("outline:2px solid var(--e-focus)"));
  assert.ok(block(css, ".nw-editor .e-url-input:focus-within").includes("outline:2px solid var(--e-focus)"));
  assert.ok(block(css, ".nw-editor button:focus-visible,.nw-editor input:focus-visible,.nw-editor select:focus-visible,.nw-editor textarea:focus-visible,.nw-editor summary:focus-visible").includes("var(--e-focus)"));
  assert.ok(block(css, ".nw-editor :is(input,textarea)::placeholder").includes("color:var(--e-placeholder)"));
  const select = block(css, ".nw-editor select");
  assert.ok(select.includes("appearance:none") && select.includes("data:image/svg+xml"), "selects draw the same grey chevron instead of the native arrow");
  assert.ok(block(css, ".nw-editor .e-frame>select").includes("color:var(--e-unit)"));
  assert.ok(block(css, ".nw-editor .e-url-prefix").includes("color:var(--e-unit)"));
});

test("disabled, pending, invalid and width-specific inputs keep a cue that is not only a color", () => {
  const [css, assetCss] = stylesheets({ assets: {} });
  const disabled = block(css, ".nw-editor :is(input,select,textarea):disabled");
  assert.ok(disabled.includes("background-color:var(--e-input-disabled)") && disabled.includes("cursor:not-allowed"));
  assert.ok(block(css, ".nw-editor :is(input,textarea)[readonly]").includes("var(--e-input-disabled)"));
  assert.ok(css.includes(".nw-editor .e-frame:has(>input:first-of-type:disabled){background-color:var(--e-input-disabled)}"), "a disabled unit field greys the whole frame");
  assert.ok(block(css, ".nw-editor .e-frame[data-pending]").includes("border-style:dashed"), "pending input stays dashed");
  assert.ok(block(css, ".nw-editor .e-frame[data-invalid]").includes("border-color:#8d3026"));
  assert.ok(block(css, ".nw-editor :is(input,textarea)[aria-invalid=true]").includes("border-color:#8d3026"));
  assert.ok(block(css, ".nw-editor .e-own .e-frame,.nw-editor .e-own>.e-control>select,.nw-editor .e-own .e-inline>select").includes("var(--e-blue-soft)"), "width-specific values keep the blue surface");
  assert.ok(block(css, ".nw-editor .e-own>.e-cap").includes("color:#245fbe"), "…and the caption color beside the reset button");
  for (const legacy of ["#f5f4f2", "#f0f3f0", "#f7f9f7", "#929292", "#e6f1e9", "outline:2px solid #bdbdbd", "accent-color:var(--e-green)"]) {
    assert.ok(!css.includes(legacy), `${legacy} left in the editor stylesheet`);
    assert.ok(!assetCss.includes(legacy), `${legacy} left in the asset stylesheet`);
  }
});
