import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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
});
