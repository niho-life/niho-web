import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("../studio/kamakura-managed-embed.tsx", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false
});
const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
const payload = (overrides = {}) => Buffer.from(JSON.stringify({ v: 1, publicId: "fixture-public", spotId: "fixture-spot", flow: "rental", parentOrigin: "https://next-kamakura.niho.life", allowedPathPrefix: "/rentalspace", launchTokenVersion: 1, builderType: "OTHER", ...overrides })).toString("base64url");
const url = (overrides = {}) => {
  const value = { flow: "rental", spot: "fixture-spot", origin: "https://niho.life", query: "", ...overrides };
  return `${value.origin}/embed/${value.flow}/${value.spot}?embed=1&launchToken=${payload(value.payload)}.${"a".repeat(43)}${value.query}`;
};

test("iframe snippet から entity を戻して URL だけを抽出し、script は扱わない", () => {
  const source = `<iframe data-niho-embed-src="${url().replaceAll("&", "&amp;")}" onload="bad()"></iframe><script>bad()</script>`;
  assert.equal(module.extractKamakuraManagedEmbedUrl(source), url());
  assert.deepEqual(module.inspectKamakuraManagedEmbed(source, "/rentalspace", "https://next-kamakura.niho.life"), { flow: "rental" });
  assert.deepEqual(module.inspectKamakuraManagedEmbed(url({ payload: { allowedPathPrefix: "/" } }), "/rentalspace", "https://next-kamakura.niho.life"), { flow: "rental" });
});

test("環境・flow・query・token の親 origin/path の不一致を理由付きで拒否する", () => {
  const cases = [
    [url({ origin: "https://app-stg.niho.life" }), /環境またはドメイン/],
    [url({ flow: "dropin" }), /flow／対象/],
    [url({ query: "&unexpected=1" }), /許可されていない query/],
    [url({ payload: { parentOrigin: "https://kamakura.niho.life" } }), /公開先ドメイン/],
    [url({ payload: { allowedPathPrefix: "/other" } }), /許可 path/],
  ];
  for (const [input, expected] of cases) assert.throws(() => module.inspectKamakuraManagedEmbed(input, "/rentalspace", "https://next-kamakura.niho.life"), expected);
});


test("本番と確認用のどちらでも、現在の公開先と一致する親originだけを受け入れる", () => {
  const origins = ["https://next-kamakura.niho.life", "https://kamakura.niho.life"];
  for (const origin of origins) {
    assert.deepEqual(module.inspectKamakuraManagedEmbed(url({ payload: { parentOrigin: origin } }), "/rentalspace", origin), { flow: "rental" });
    for (const other of [...origins, "https://other.example"]) {
      if (other !== origin) assert.throws(() => module.inspectKamakuraManagedEmbed(url({ payload: { parentOrigin: other } }), "/rentalspace", origin), /公開先ドメイン/);
    }
  }
  for (const invalid of [undefined, "https://other.example", "https://kamakura.niho.life/", "https://kamakura.niho.life:443", "http://kamakura.niho.life"]) {
    assert.throws(() => module.inspectKamakuraManagedEmbed(url({ payload: { parentOrigin: invalid } }), "/rentalspace", invalid), /公開先ドメイン/);
  }
});
