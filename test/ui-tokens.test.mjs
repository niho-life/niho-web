import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { uiColor, uiInput, uiTokensCss } from "@niho/web/ui-tokens";

// 配色トークンの一本化（#159）。色の値は src/ui-tokens.ts だけに置き、各画面の CSS は var(--nw-*) だけを使う。
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
/** 各画面の CSS の元（TS の文字列と Studio の shell）。ここには色の値を書かない。 */
const styleSources = [
  ...readdirSync(join(root, "src")).filter((name) => /-style(?:-css)?\.ts$/u.test(name)).map((name) => `src/${name}`),
  "studio/public/studio.css",
  "studio/rich-text-style.ts",
  "src/editor-localization.tsx"
];
// 「#159」のような Issue 番号を色と取り違えないよう、色の前に来る文字を限る。コメントだけの行は見ない。
const hexColor = /(?<=[:\s(,"'`=])#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/giu;
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line));

function rgb(hex) {
  const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((digit) => digit + digit).join("") : hex.slice(0, 6);
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16));
}
function parseColor(value) {
  if (value.startsWith("#")) return [...rgb(value.slice(1)), 1];
  const match = /^rgba?\(([\d.]+),([\d.]+),([\d.]+)(?:,([\d.]+))?\)$/u.exec(value.replaceAll(" ", ""));
  assert.ok(match, `unsupported color ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}
/** 半透明の色は下の面に重ねてから測る。 */
function over(color, ground) {
  const [r, g, b, a] = parseColor(color), base = parseColor(ground);
  return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
}
function luminance([r, g, b]) {
  const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(foreground, background) {
  const back = over(background, "#fff"), [a, b] = [luminance(over(foreground, `rgb(${back.join(",")})`)), luminance(back)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
function hsl(hex) {
  const [r, g, b] = rgb(hex).map((value) => value / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0, light };
  const delta = max - min, saturation = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r ? ((g - b) / delta + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / delta + 2) * 60 : ((r - g) / delta + 4) * 60;
  return { hue, saturation, light };
}
function walk(directory, skip) {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (skip.has(path)) return [];
    return statSync(join(root, path)).isDirectory() ? walk(path, skip) : /\.(?:ts|tsx|css|mjs)$/u.test(name) ? [path] : [];
  });
}

test("the tokens carry the STUDIO measurements and keep the input values of #71", () => {
  for (const declaration of [
    "--nw-bg:#fff", "--nw-surface:#f7f7f7", "--nw-surface-2:#f2f2f2", "--nw-text:#1a1a1a", "--nw-text-sub:rgba(34,34,34,.7)",
    "--nw-border:rgba(34,34,34,.1)", "--nw-accent:#0f70eb", "--nw-focus:var(--nw-accent)", "--nw-radius-sm:4px", "--nw-radius:6px", "--nw-radius-lg:8px",
    "--nw-font-size:14px", "--nw-font-size-label:12px", "--nw-font-size-sub:11px",
    "--e-input:#f2f2f2", "--e-input-border:#e3e3e3", "--e-input-disabled:#e9e9e9", "--e-placeholder:#858585", "--e-unit:#666", "--e-radius:6px", "--e-focus:var(--e-blue)"
  ]) assert.ok(uiTokensCss.includes(declaration), declaration);
  assert.ok(uiTokensCss.startsWith(":where(:root){"), "zero specificity, so a host can override any token");
  assert.match(uiTokensCss, /--nw-font:Inter,"Noto Sans JP",/u);
  assert.equal(uiInput.surface, uiColor.surface2);
});

test("text keeps 4.5:1, secondary text and indicators keep 3:1", () => {
  const grounds = [uiColor.bg, uiColor.surface, uiColor.surface2, uiColor.hover, uiColor.pressed];
  for (const ground of grounds) {
    assert.ok(contrast(uiColor.text, ground) >= 4.5, `text on ${ground}`);
    assert.ok(contrast(uiColor.textSub, ground) >= 4.5, `secondary text on ${ground}`);
  }
  for (const [foreground, background, minimum] of [
    [uiColor.accent, uiColor.bg, 4.5], [uiColor.onAccent, uiColor.accent, 4.5], [uiColor.accentStrong, uiColor.accentSoft, 4.5], [uiColor.onAccent, uiColor.accentStrong, 4.5],
    [uiColor.onInverse, uiColor.inverse, 4.5], [uiColor.onInverse, uiColor.inverseHover, 4.5],
    [uiColor.danger, uiColor.bg, 4.5], [uiColor.danger, uiColor.dangerSoft, 4.5], [uiColor.onDanger, uiColor.danger, 4.5],
    [uiColor.warning, uiColor.bg, 4.5], [uiColor.warning, uiColor.warningSoft, 4.5], [uiColor.component, uiColor.componentSoft, 4.5],
    [uiColor.textFaint, uiColor.bg, 3], [uiInput.placeholder, uiInput.surface, 3], [uiColor.live, uiColor.bg, 3]
  ]) assert.ok(contrast(foreground, background) >= minimum, `${foreground} on ${background}`);
});

test("screen stylesheets use the tokens only: no color values, shadows that float, kickers or decorations", () => {
  for (const path of styleSources) {
    const code = codeLines(read(path)).join("\n");
    assert.deepEqual(code.match(hexColor) ?? [], [], `${path} hex colors`);
    assert.deepEqual(code.match(/rgba?\(|hsla?\(|(?<![-\w])(?:white|black)(?![-\w])/gu) ?? [], [], `${path} color functions`);
    assert.deepEqual(code.match(/--(?:niho|cw|lw|pv|pm|an|sa)-(?!sticky-top|lead)[a-z-]+/gu) ?? [], [], `${path} private color variables`);
    assert.doesNotMatch(code, /radial-gradient|backdrop-filter|text-transform:uppercase|letter-spacing:\.1\d*em|outline:3px/u, `${path} decoration`);
    assert.doesNotMatch(code, /border-radius:(?:9|1\d)px/u, `${path} large radius`);
    // 影は使わない。残すのは枠の代わりの 1〜2px の線と、内側の帯だけ。
    for (const shadow of code.match(/box-shadow:[^;}]+/gu) ?? []) assert.match(shadow, /^box-shadow:(?:none|inset -?\d+(?:px)? -?\d+(?:px)? 0 |0 0 0 \dpx )/u, `${path} ${shadow}`);
  }
  assert.doesNotMatch(read("studio/client.tsx"), /studio-kicker/u, "the uppercase kicker above headings is gone");
});

test("every variable a screen stylesheet reads is defined by the tokens or by that stylesheet", () => {
  // 廃止した名前（--e-green など）を読むと色が消えるので、定義の無い var() を拒む。ホストが渡す値は予備値付きで読む。
  const defined = new Set([...uiTokensCss.matchAll(/--([a-z0-9-]+):/gu)].map((match) => match[1]));
  const sources = styleSources.map((path) => [path, read(path)]);
  for (const [, code] of sources) for (const match of code.matchAll(/--([a-z0-9-]+):/gu)) defined.add(match[1]);
  const missing = sources.flatMap(([path, code]) => [...code.matchAll(/var\(--([a-z0-9-]+)(,?)/gu)].filter((match) => !match[2] && !defined.has(match[1])).map((match) => `${path} --${match[1]}`));
  assert.deepEqual([...new Set(missing)], []);
});

test("focus rings are 2px and blue on every screen", () => {
  for (const path of styleSources) {
    const code = read(path);
    for (const outline of code.match(/:focus(?:-visible|-within)[^{]*\{[^}]*outline:[^;}]+/gu) ?? []) {
      assert.match(outline, /outline:(?:2px solid var\(--(?:nw|e)-focus\)|none)/u, `${path} ${outline.slice(-60)}`);
    }
  }
});

test("no green or warm grey is left in the Studio UI except the published dot", () => {
  // 凍結中の Experience エディター（studio/build.mjs が bundle への混入を拒む）とビルド出力は見ない。
  const skip = new Set(["studio/dist", "studio/migrations", "studio/experience-editor.tsx"]);
  const found = [];
  for (const path of [...walk("src", skip), ...walk("studio", skip)]) {
    for (const line of codeLines(read(path))) {
      for (const match of line.matchAll(hexColor)) {
        const { hue, saturation } = hsl(match[1]);
        const green = hue >= 70 && hue <= 175 && saturation > 0.04, warm = hue >= 15 && hue <= 65 && saturation > 0.02 && saturation < 0.35;
        if ((green || warm) && !(path === "src/ui-tokens.ts" && match[0] === uiColor.live)) found.push(`${path} ${match[0]}`);
      }
    }
  }
  assert.deepEqual(found, []);
});
