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
  assert.deepEqual(module.inspectKamakuraManagedEmbed(source, "/rentalspace"), { flow: "rental" });
  assert.deepEqual(module.inspectKamakuraManagedEmbed(url({ payload: { allowedPathPrefix: "/" } }), "/rentalspace"), { flow: "rental" });
});

test("環境・flow・query・token の親 origin/path の不一致を理由付きで拒否する", () => {
  const cases = [
    [url({ origin: "https://app-stg.niho.life" }), /環境またはドメイン/],
    [url({ flow: "dropin" }), /flow／対象/],
    [url({ query: "&unexpected=1" }), /許可されていない query/],
    [url({ payload: { parentOrigin: "https://kamakura.niho.life" } }), /公開先ドメイン/],
    [url({ payload: { allowedPathPrefix: "/other" } }), /許可 path/],
  ];
  for (const [input, expected] of cases) assert.throws(() => module.inspectKamakuraManagedEmbed(input, "/rentalspace"), expected);
});
