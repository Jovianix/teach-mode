import { build } from "esbuild";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHostRelease } from "../../scripts/release-validation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)), require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
const descriptorPath = process.env.MEMMY_HOST_RELEASE_DESCRIPTOR;
let hostRelease;
if (descriptorPath) {
  hostRelease = JSON.parse(await readFile(descriptorPath, "utf8"));
  validateHostRelease(hostRelease, manifest.requiredHostCapabilities, process.env.MEMMY_PLUGIN_RELEASE === "1");
  manifest.minimumHostVersion = hostRelease.version;
}
if (process.env.MEMMY_PLUGIN_RELEASE === "1" && (!hostRelease || dirty)) {
  throw new Error("Publishing requires a clean plugin commit and a released Host descriptor");
}

const dist = join(root, "dist"); await rm(dist, { recursive: true, force: true }); await mkdir(dist, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["src/index.ts"], outfile: join(dist, "index.js"), bundle: true,
  platform: "node", target: "node22", format: "esm", external: ["playwright-core"],
  banner: { js: "import { createRequire as __memmyCreateRequire } from 'node:module'; const require = __memmyCreateRequire(import.meta.url);" } });
for (const file of ["browser-recorder.js", "notepad-control.ps1", "browser-guardian.ps1"]) await cp(join(root, "src", file), join(dist, file));
const zip = new JSZip();
const originalFile = zip.file.bind(zip);
zip.file = (name, data, options) => originalFile(name, data, { date: new Date("1980-01-01T00:00:00Z"), ...options });
zip.file("build.json", JSON.stringify({ schema: "memmy.plugin-build/v1", sourceCommit, dirty,
  hostRequirement: { version: manifest.minimumHostVersion, sourceCommit: hostRelease?.sourceCommit ?? null, capabilities: manifest.requiredHostCapabilities } }));
zip.file("plugin.json", JSON.stringify(manifest)); zip.file("package.json", JSON.stringify({ type: "module", private: true }));
async function addTree(source, prefix) {
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink()) throw new Error("Symlink in plugin package");
    const file = join(source, entry.name), name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await addTree(file, name); else zip.file(name, await readFile(file));
  }
}
await addTree(dist, "dist"); await addTree(join(root, "skills"), "skills");
if (manifest.ui) await addTree(join(root, "ui"), "ui");
await addTree(dirname(require.resolve("playwright-core/package.json")), "node_modules/playwright-core");
const output = join(root, "..", "releases"); await mkdir(output, { recursive: true });
// JSZip creates parent directory entries internally; normalize those dates too.
for (const entry of Object.values(zip.files)) entry.date = new Date("1980-01-01T00:00:00Z");
const file = `${manifest.id}-${manifest.version}.zip`, bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
if (bytes.length > 50 * 1024 * 1024 || Object.keys(zip.files).length > 2000) throw new Error("Plugin exceeds Host archive limits");
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(join(output, file), bytes);
await writeFile(join(output, `${manifest.id}-${manifest.version}.release.json`), JSON.stringify({ manifest,
  artifact: { url: `/artifacts/${file}`, sha256 }, nativeExecutionAllowed: true,
  sourceCommit, dirty, hostRelease: hostRelease ?? null, publishable: !dirty && hostRelease?.dirty === false && Boolean(hostRelease.release) }, null, 2));
await writeFile(join(output, "catalog.json"), JSON.stringify([manifest], null, 2));
console.log(`${relative(process.cwd(), join(output, file))} (${bytes.length} bytes, SHA-256 ${sha256})`);
