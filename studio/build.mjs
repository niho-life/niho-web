import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(studioDirectory, "dist");
const publicOutput = join(outputDirectory, "public");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(publicOutput, "assets"), { recursive: true });

await Promise.all([
  (async () => {
    const result = await build({
    entryPoints: [join(studioDirectory, "client.tsx")],
    outfile: join(publicOutput, "assets", "app.js"),
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
  // 本文の編集部品の CSS（CSP で inline の <style> を使えない）は studio.css の後ろに足す
  (async () => {
    const [studioCss, { studioRichTextCss }] = await Promise.all([readFile(join(studioDirectory, "public", "studio.css"), "utf8"), cssModule("rich-text-style.ts", studioDirectory)]);
    await writeFile(join(publicOutput, "assets", "studio.css"), `${studioCss.trimEnd()}\n${studioRichTextCss.trim()}\n`);
  })(),
  (async () => {
    const { projectViewCss } = await cssModule("project-view-style.ts", join(studioDirectory, "..", "src"));
    await writeFile(join(publicOutput, "assets", "project-view.css"), projectViewCss);
  })()
]);

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
