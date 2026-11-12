import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "studio", "dist", "public");
const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

test("Studio serves an index and entry assets whose paths change with their contents", () => {
  execFileSync(process.execPath, ["studio/build.mjs"], { cwd: root });
  const indexNames = readdirSync(publicDir).filter((name) => /^index-[0-9a-f]{12}\.html$/u.test(name));
  assert.equal(indexNames.length, 1);
  const indexName = indexNames[0];
  const html = readFileSync(join(publicDir, indexName), "utf8");
  assert.equal(readFileSync(join(publicDir, "index.html"), "utf8"), html);
  assert.equal(indexName, `index-${fingerprint(html)}.html`);
  for (const name of ["studio.css", "project-view.css", "collection.css", "localization.css", "app.js"]) {
    const stem = name.slice(0, name.lastIndexOf(".")), extension = name.split(".").at(-1);
    const match = html.match(new RegExp(`/assets/${stem}-([0-9a-f]{12})\\.${extension}`, "u"));
    assert.ok(match, `${name} must use a versioned URL`);
    const versionedName = `${stem}-${match[1]}.${extension}`;
    assert.equal(match[1], fingerprint(readFileSync(join(publicDir, "assets", versionedName))));
  }
  assert.match(readFileSync(join(root, "studio", "dist", "worker.js"), "utf8"), new RegExp(indexName, "u"));
  assert.match(readFileSync(join(publicDir, "assets", "studio.css"), "utf8"), /\.nw-language-options\{display:grid/u);

  // トークンの書体（Inter・Noto Sans JP）は自前で配る。@font-face の CSS も中身の hash を名前に持ち、Worker が長くキャッシュさせる
  const fontsLink = html.match(/\/assets\/fonts\/(fonts-([0-9a-f]{12})\.css)/u);
  assert.ok(fontsLink, "the font stylesheet uses a versioned URL");
  assert.ok(html.indexOf(fontsLink[0]) < html.indexOf("/assets/studio-"), "the faces are declared before the screens use them");
  const fontsDir = join(publicDir, "assets", "fonts");
  const fontsCss = readFileSync(join(fontsDir, fontsLink[1]), "utf8");
  assert.equal(fontsLink[2], fingerprint(fontsCss));
  const families = new Map();
  for (const face of fontsCss.match(/@font-face\{[^}]*\}/gu) ?? []) {
    const family = /font-family:"([^"]+)";/u.exec(face)?.[1];
    families.set(family, (families.get(family) ?? 0) + 1);
    assert.match(face, /font-weight:100 900;/u, "one variable font covers 400 and 600");
    const file = /src:url\(([a-z0-9-]+-\d+\.\d+\.\d+\/[a-z0-9-]+\.woff2)\) format\('woff2-variations'\)/u.exec(face)?.[1];
    assert.ok(file, face.slice(0, 160));
    assert.ok(statSync(join(fontsDir, file)).size > 0, file);
  }
  assert.deepEqual([...families.keys()].sort(), ["Inter", "Noto Sans JP"], "the families are the names in --nw-font");
  assert.ok(families.get("Noto Sans JP") >= 100, "Japanese is split by unicode-range, so a page reads only the characters it shows");
  for (const directory of readdirSync(fontsDir).filter((name) => !name.endsWith(".css"))) {
    assert.match(readFileSync(join(fontsDir, directory, "OFL.txt"), "utf8"), /SIL Open Font License/u, directory);
  }
  assert.doesNotMatch(readFileSync(join(publicDir, "assets", "studio.css"), "utf8"), /@font-face/u, "studio.css (no-store) does not carry the faces");
});
