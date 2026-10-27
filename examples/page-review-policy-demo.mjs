import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = 4181;
const result = await build({ entryPoints: [fileURLToPath(new URL("./page-review-policy-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = result.outputFiles[0].text;
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ページの公開設定 · デモ</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#17212b;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif}.demo{max-width:760px;margin:56px auto;padding:0 24px}.demo header{margin-bottom:28px}.demo header span{font-size:12px;color:#697784}.demo h1{font-size:25px;letter-spacing:-.02em;margin:4px 0}.demo header p{margin:0;color:#697784}.demo .e-page-settings{display:grid;gap:16px}.demo .e-section{background:#fff;border:1px solid #dde3e8;border-radius:12px;padding:22px 24px;box-shadow:0 2px 8px #1b283808}.demo .e-section h3{font-size:15px;margin:0 0 15px}.demo .e-rows{margin:0}.demo .e-rows>div{display:flex;justify-content:space-between;gap:18px;padding:7px 0;border-bottom:1px solid #edf0f2}.demo .e-rows>div:last-child{border:0}.demo dt{color:#697784}.demo dd{margin:0}.demo .e-check{display:flex;gap:10px;align-items:center;font-weight:600}.demo .e-check input{width:18px;height:18px;accent-color:#2369d1}.demo .e-help{display:block;margin-top:8px;color:#697784;font-size:12px}.demo footer{margin:20px 0;color:#446171}
</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (path !== "/" && path !== "/app.js") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", path === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(path === "/app.js" ? script : html);
}).listen(port, "127.0.0.1", () => console.log(`Page review policy demo: http://127.0.0.1:${port}`));
