import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const PRODUCTION_ORIGIN = "https://next-kamakura.niho.life";
const PREVIEW_ORIGIN = "https://studio-upload-preview.example.test";

async function loadOriginReader() {
  const result = await build({ entryPoints: [new URL("../studio/kamakura-upload-origin.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}

function documentWith(content) {
  return {
    querySelector(selector) {
      assert.equal(selector, 'meta[name="niho-studio-upload-origin"]');
      return content === null ? null : { getAttribute: (name) => name === "content" ? content : null };
    }
  };
}

test("Kamakura upload origin reads the exact Studio page setting and rejects malformed values", async () => {
  const { kamakuraUploadOrigin } = await loadOriginReader();
  assert.equal(kamakuraUploadOrigin(documentWith(PREVIEW_ORIGIN)), PREVIEW_ORIGIN);
  assert.equal(kamakuraUploadOrigin(documentWith(null)), PRODUCTION_ORIGIN);
  for (const value of ["http://preview.example.test", "https://user:pass@preview.example.test", "https://preview.example.test/path", "https://preview.example.test?x=1"]) {
    assert.equal(kamakuraUploadOrigin(documentWith(value)), PRODUCTION_ORIGIN);
  }
});
