import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// 4173〜4179 はほかのデモが使うので、翻訳の画面のデモは 4180。
const port = 4180;
const output = await build({ entryPoints: [fileURLToPath(new URL("./localization-workspace-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text;
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web 翻訳の画面のデモ</title>
<style>body{margin:0;background:#f6f5f2;font:13px sans-serif}.demo-tools{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:8px 16px;background:#23211d;color:#fff}.demo-tools button,.demo-tools select{min-height:32px;border:1px solid #fff6;border-radius:6px;background:none;color:inherit;padding:0 10px;font:inherit}.demo-tools select option{color:#000}.demo-tools label{display:inline-flex;gap:6px;align-items:center}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

// 描画用の枠（デモ）。実際のサイトは自分の描画のコードでページを組み立てる。ここでは材料を簡単な形で並べるだけ。
// sandbox="allow-scripts"（allow-same-origin なし）で開かれるので、送り元（parent）と nonce だけを確かめる。
const frame = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>描画用の枠（デモ）</title>
<style>body{margin:0;font:15px/1.8 sans-serif;color:#23211d;background:#fff}main{max-width:720px;margin:0 auto;padding:24px 20px}h1{font-size:24px;line-height:1.4}section{margin:18px 0;padding-top:12px;border-top:1px solid #e3e0d9}small{color:#66625a}img{max-width:100%;border-radius:8px}.mark{padding:0 4px;border-radius:4px;background:#e6edf9;color:#2a4f8f}.missing{color:#b02e2e}a{color:#2457b5}</style></head>
<body><main id="out"><p>プレビューを待っています…</p></main><script>
const nonce = new URLSearchParams(location.hash.slice(1)).get("niho-preview");
const send = (event, extra) => parent.postMessage(Object.assign({ type: "niho-localization-preview", protocol: 1, nonce, event }, extra || {}), "*");
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const marked = (text, marks) => esc(text).replace(/\\u27e6([A-Za-z0-9_-]{1,32})\\u27e7/g, (_, id) => '<span class="mark">' + esc((marks.find((m) => m.id === id) || { label: "印" }).label) + "</span>");
const rich = (nodes) => nodes.map((node) => node.type === "text" ? esc(node.text) : node.tag === "br" ? "<br>" : "<" + node.tag + (node.tag === "a" ? ' href="#"' : "") + ">" + rich(node.children) + "</" + node.tag + ">").join("");
function render(message) {
  const page = message.materials.find((part) => part.part === "page") || {};
  const units = (message.materials.find((part) => part.part === "units") || { units: [] }).units;
  const overrides = new Map(message.overrides.map((entry) => [entry.unitId, entry.value]));
  const english = message.locale === "en";
  const body = units.map((unit) => {
    const value = english ? (overrides.has(unit.unitId) ? overrides.get(unit.unitId) : unit.value) : unit.source;
    let content;
    if (unit.kind === "image") content = '<img alt="" src="' + esc((value || unit.source).url) + '">';
    else if (value === null) content = '<span class="missing">（まだ訳していません）</span> ' + (unit.kind === "text" ? marked(unit.source, unit.marks) : rich(unit.source.children));
    else content = unit.kind === "text" ? marked(value, unit.marks) : rich(value.children);
    return "<section><small>" + esc(unit.label) + "</small><div>" + content + "</div></section>";
  }).join("");
  document.documentElement.lang = message.locale;
  document.getElementById("out").innerHTML = "<small>" + esc(page.path || "") + (message.width ? "・幅 " + message.width + "px" : "") + "</small><h1>" + esc(page.title || "") + "</h1>" + body;
}
window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const data = event.data;
  if (!data || data.type !== "niho-localization-preview" || data.protocol !== 1 || data.nonce !== nonce || data.event !== "render") return;
  try { render(data); send("rendered"); } catch (error) { send("error", { message: "描けませんでした。" }); }
});
document.addEventListener("click", (event) => { if (event.target.closest("a")) event.preventDefault(); }, true);
document.addEventListener("submit", (event) => event.preventDefault(), true);
send("ready");
</script></body></html>`;

const swatches = { "cover-ja": ["#dce9de", "#7ea886", "日本語"], "cover-en": ["#d9dcef", "#6f78b5", "English"] };
const svg = (name) => {
  const [ground, accent, label] = swatches[name];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="${ground}"/><circle cx="470" cy="150" r="90" fill="${accent}"/><text x="40" y="320" font-size="40" font-family="sans-serif" fill="#23211d">${label}</text></svg>`;
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
  const media = /^\/media\/(?:(cover-ja|cover-en)\.svg|(u-\d+))$/u.exec(url.pathname);
  if (media) {
    if (media[1]) { response.setHeader("Content-Type", "image/svg+xml; charset=utf-8"); response.end(svg(media[1])); return; }
    const stored = uploads.get(media[2]);
    if (!stored) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", stored.type);
    response.end(stored.body);
    return;
  }
  if (url.pathname === "/frame.html") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(frame); return; }
  if (url.pathname !== "/" && url.pathname !== "/app.js") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(url.pathname === "/app.js" ? script : html);
}).listen(port, "127.0.0.1", () => console.log(`Localization workspace demo: http://127.0.0.1:${port}`));
