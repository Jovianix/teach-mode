import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.MEMMY_PLUGIN_RELEASES_DIR || fileURLToPath(new URL("../releases", import.meta.url));
export function createRegistryServer(directory = root) {
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
      const url = new URL(request.url, "http://registry.local");
      let file;
      if (url.pathname === "/api/v1/plugins/catalog") file = "catalog.json";
      else {
        const plugin = /^\/api\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,127})$/.exec(url.pathname);
        const artifact = /^\/artifacts\/([a-z0-9][a-z0-9._-]*\.zip)$/.exec(url.pathname);
        if (artifact) file = artifact[1];
        else if (plugin) {
          const catalog = JSON.parse(await readFile(join(directory, "catalog.json"), "utf8"));
          const version = url.searchParams.get("version") || catalog.find(p => p.id === plugin[1])?.version;
          if (!version || !/^[a-zA-Z0-9._-]+$/.test(version)) throw new Error("not_found");
          file = `${plugin[1]}-${version}.release.json`;
        } else throw new Error("not_found");
      }
      const info = await stat(join(directory, file));
      response.writeHead(200, { "content-type": file.endsWith(".zip") ? "application/zip" : "application/json",
        "content-length": info.size, "cache-control": file.endsWith(".zip") ? "public,max-age=31536000,immutable" : "no-cache" });
      if (request.method === "HEAD") response.end(); else createReadStream(join(directory, file)).pipe(response);
    } catch { response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || "19090");
  createRegistryServer().listen(port, "127.0.0.1", () => console.log(`Plugin registry: http://127.0.0.1:${port}`));
}
