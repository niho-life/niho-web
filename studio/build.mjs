import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const studioDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(studioDirectory, "dist");
const publicOutput = join(outputDirectory, "public");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(publicOutput, "assets"), { recursive: true });

await Promise.all([
  (async () => {
    // CMS のコレクション画面（CollectionWorkspace・TipTap）と翻訳の画面（LocalizationWorkspace）は import() で分け、開いたときだけ読む（assets/chunks/）。
    const result = await build({
    entryPoints: { app: join(studioDirectory, "client.tsx") },
    outdir: join(publicOutput, "assets"),
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    splitting: true,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    metafile: true
    });
    // Kamakura は凍結中も読み取り専用で開く（kamakura-site#84）。Experience の editor は休止のまま入れない。
    const forbidden = Object.keys(result.metafile.inputs).filter((input) => /studio\/(?:integration-entry|experience-editor)\.tsx$/u.test(input));
    if (forbidden.length) throw new Error(`Frozen editor code entered the Studio client bundle: ${forbidden.join(", ")}`);
    // 最初に読む分（app.js と、そこから静的に import する chunk）に本文の編集部品・CMS と翻訳の画面を入れない
    const eager = new Set(), queue = [relative(process.cwd(), join(publicOutput, "assets", "app.js")).replaceAll("\\", "/")];
    while (queue.length) {
      const output = queue.shift();
      if (eager.has(output)) continue;
      eager.add(output);
      for (const entry of result.metafile.outputs[output]?.imports ?? []) if (entry.kind === "import-statement" && !entry.external) queue.push(entry.path);
    }
    const eagerInputs = [...eager].flatMap((output) => Object.keys(result.metafile.outputs[output]?.inputs ?? {}));
    const eagerLazy = eagerInputs.filter((input) => /(?:@tiptap|prosemirror|studio\/rich-text-editor\.tsx|src\/collection-workspace\.tsx)/u.test(input));
    if (eagerLazy.length) throw new Error(`CMS workspace code entered the initial Studio client bundle: ${eagerLazy.slice(0, 5).join(", ")}`);
    const eagerTranslations = eagerInputs.filter((input) => /(?:src\/localization-workspace(?:-[a-z]+)?\.tsx?|studio\/kamakura-localization(?:-workspace|-contract)?\.tsx?)$/u.test(input));
    if (eagerTranslations.length) throw new Error(`Translation workspace code entered the initial Studio client bundle: ${eagerTranslations.slice(0, 5).join(", ")}`);
  })(),
  build({
    entryPoints: [join(studioDirectory, "worker.ts")],
    outfile: join(outputDirectory, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none"
  }),
  copyFile(join(studioDirectory, "public", "index.html"), join(publicOutput, "index.html")),
  // 配色・角丸・文字のトークン（src/ui-tokens.ts）は全ページが最初に読む studio.css の先頭に置く（#159）。
  // 本文の編集部品の CSS（CSP で inline の <style> を使えない）は studio.css の後ろに足す
  (async () => {
    const [studioCss, { studioRichTextCss }, uiTokensCss] = await Promise.all([readFile(join(studioDirectory, "public", "studio.css"), "utf8"), cssModule("rich-text-style.ts", studioDirectory), tokensCss()]);
    await writeFile(join(publicOutput, "assets", "studio.css"), `${uiTokensCss.trim()}\n${studioCss.trim()}\n${studioRichTextCss.trim()}\n`);
  })(),
  // 部品の CSS は先頭にトークンを持つ（ほかのホストは <style> だけで描ける）。Studio は studio.css で読むので外す
  (async () => {
    const [{ projectViewCss }, uiTokensCss] = await Promise.all([cssModule("project-view-style.ts", join(studioDirectory, "..", "src")), tokensCss()]);
    await writeFile(join(publicOutput, "assets", "project-view.css"), withoutTokens(projectViewCss, uiTokensCss, "projectViewCss"));
  })(),
  // CMS のコレクション画面の CSS（部品の inline の <style> は CSP で当たらない）
  (async () => {
    const [{ collectionCss }, uiTokensCss] = await Promise.all([cssModule("collection-style.ts", join(studioDirectory, "..", "src")), tokensCss()]);
    await writeFile(join(publicOutput, "assets", "collection.css"), withoutTokens(collectionCss, uiTokensCss, "collectionCss"));
  })(),
  // 翻訳の画面だけの CSS（localizationWorkspaceCss は collectionCss の後ろに足したもの。collectionCss は上の collection.css）
  (async () => {
    const [{ collectionCss }, { localizationWorkspaceCss }] = await Promise.all([
      cssModule("collection-style.ts", join(studioDirectory, "..", "src")),
      cssModule("localization-workspace-style.ts", join(studioDirectory, "..", "src"))
    ]);
    if (!localizationWorkspaceCss.startsWith(collectionCss)) throw new Error("localizationWorkspaceCss no longer starts with collectionCss");
    await writeFile(join(publicOutput, "assets", "localization.css"), localizationWorkspaceCss.slice(collectionCss.length));
  })()
]);

/** src/ui-tokens.ts のトークンの CSS。 */
async function tokensCss() {
  const { uiTokensCss } = await cssModule("ui-tokens.ts", join(studioDirectory, "..", "src"));
  return uiTokensCss;
}

/** 部品の CSS から先頭のトークンを外す。先頭に無ければ build を止める（studio.css だけが定義を持つ前提が崩れるため）。 */
function withoutTokens(css, uiTokensCss, name) {
  if (!css.startsWith(uiTokensCss)) throw new Error(`${name} no longer starts with uiTokensCss`);
  return css.slice(uiTokensCss.length);
}

/** CSS の文字列を export する TS を読み込む。 */
async function cssModule(file, directory) {
  const result = await build({
    entryPoints: [join(directory, file)],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false
  });
  const source = result.outputFiles[0]?.text;
  if (!source) throw new Error(`${file} build produced no output`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const workerBundle = await readFile(join(outputDirectory, "worker.js"), "utf8");
for (const forbidden of ["https://api.niho.life", "https://api-stg.niho.life"]) {
  if (workerBundle.includes(forbidden)) throw new Error(`Frozen editor upstream entered the Studio Worker bundle: ${forbidden}`);
}
