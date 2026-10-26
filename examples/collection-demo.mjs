import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// 4173〜4178 はほかのデモが使うので、コレクションのデモは 4179。
const port = 4179;
const output = await build({ entryPoints: [fileURLToPath(new URL("./collection-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text;
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web コレクションのデモ</title>
<style>body{margin:0;font:13px sans-serif}.demo-tools{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--nw-border);background:var(--nw-surface);color:var(--nw-text)}.demo-tools button{min-height:32px;border:1px solid var(--nw-border-strong);border-radius:var(--nw-radius);background:var(--nw-bg);color:inherit;padding:0 10px;font:inherit}.demo-tools label{display:inline-flex;gap:6px;align-items:center}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const swatches = { green: ["#dce9de", "#7ea886"], sand: ["#efe4d2", "#c9a46b"], dusk: ["#d9dcef", "#6f78b5"] };
const seed = (name) => {
  const [ground, accent] = swatches[name] ?? swatches.green;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420"><rect width="640" height="420" fill="${ground}"/><circle cx="470" cy="170" r="96" fill="${accent}"/><path d="M0 330 Q160 260 320 320 T640 300 V420 H0Z" fill="${accent}" opacity=".7"/></svg>`;
};
const uploads = new Map();
let uploadCount = 0;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "POST" && url.pathname === "/upload") {
    const type = String(request.headers["content-type"] ?? "");
    if (!/^image\/(png|jpeg|gif|webp|avif)$/u.test(type)) { request.resume(); response.writeHead(415).end(); return; }
    const chunks = [];
    let size = 0, tooLarge = false;
    request.on("data", (chunk) => { size += chunk.length; if (size > 5 * 1024 * 1024) tooLarge = true; else chunks.push(chunk); });
    request.on("end", () => {
      if (tooLarge) { response.writeHead(413).end(); return; }
      const name = `u-${++uploadCount}`;
      uploads.set(name, { type, body: Buffer.concat(chunks) });
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ url: `/media/${name}` }));
    });
    return;
  }
  const media = /^\/media\/(seed-(green|sand|dusk)\.svg|u-\d+)$/u.exec(url.pathname);
  if (media) {
    if (media[2]) { response.setHeader("Content-Type", "image/svg+xml; charset=utf-8"); response.end(seed(media[2])); return; }
    const stored = uploads.get(media[1]);
    if (!stored) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", stored.type);
    response.end(stored.body);
    return;
  }
  if (url.pathname.startsWith("/preview/")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>プレビュー（デモ）</title><body style="font:15px/1.8 sans-serif;padding:32px"><h1>プレビュー（デモ）</h1><p>実際のホストは、ここで保存済みの下書きをサイトの見た目で組み立てます。デモでは中身を出しません。</p></body></html>');
    return;
  }
  if (url.pathname !== "/" && url.pathname !== "/app.js") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(url.pathname === "/app.js" ? script : html);
}).listen(port, "127.0.0.1", () => console.log(`Collection demo: http://127.0.0.1:${port}`));
