import fs from "node:fs";
import path from "node:path";
import { downloadPinned, extractPinned } from "./pinned-artifacts.mjs";
const root = path.resolve(".cache");
for (const [name, prefix] of [["host-kit", "MEMMY_HOST_KIT"], ["windows-acceptance", "MEMMY_WINDOWS_ACCEPTANCE"]]) {
  const file = await downloadPinned(process.env[prefix + "_URL"], process.env[prefix + "_SHA256"], path.join(root, name + ".zip"));
  await extractPinned(file, path.join(root, name));
}
const values = { MEMMY_HOST_KIT_DIR: path.join(root, "host-kit"), MEMMY_HOST_RELEASE_DESCRIPTOR: path.join(root, "host-kit/host-release.json"),
  MEMMY_WINDOWS_ACCEPTANCE_REPORT: path.join(root, "windows-acceptance/report.json"), MEMMY_PLUGIN_ZIP: path.resolve("releases/teach-mode-0.3.0.zip") };
if (!process.env.GITHUB_ENV) throw new Error("Release preparation requires the CI environment file");
for (const [key, value] of Object.entries(values)) fs.appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
