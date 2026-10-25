import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// ホストの表示部品を同じ iframe へ差し込む動作例。127.0.0.1 限定で、認証・外部 API には接続しない。
const output = await build({ entryPoints: [fileURLToPath(new URL("./host-preview-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text, port = Number(process.env.PORT) || 4178;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web ホスト表示部品の動作例</title></head><body style="margin:0;padding:20px;background:#eef1ed"><p style="font:13px sans-serif">ホストの営業日カレンダーと記事一覧を、キャンバスの同じ iframe に公開と同じ部品・CSS・合成データで描く動作例です。表示幅を 768px 未満にするとカレンダーが一覧に変わります。保存はメモリ内だけで、公開はしません。</p><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET" || !["/", "/app.js"].includes(path)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", path === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(path === "/app.js" ? script : html);
}).listen(port, "127.0.0.1", () => console.log(`Host preview demo: http://127.0.0.1:${port}`));
