import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = 4182;
const result = await build({ entryPoints: [fileURLToPath(new URL("./site-language-settings-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = result.outputFiles[0].text;
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>サイトの言語 · デモ</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7f8;color:#243340;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif}.demo{max-width:840px;margin:54px auto;padding:0 24px}.demo header{margin-bottom:26px}.demo small{color:#71808b}.demo h1{font-size:27px;letter-spacing:-.03em;margin:4px 0}.demo header p{color:#71808b;margin:0}.demo-lock{margin-top:22px;border:1px solid #cfd8de;border-radius:9px;background:#fff;color:#426178;padding:9px 14px;cursor:pointer}
</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (path !== "/" && path !== "/app.js") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", path === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(path === "/app.js" ? script : html);
}).listen(port, "127.0.0.1", () => console.log(`Site language settings demo: http://127.0.0.1:${port}`));
