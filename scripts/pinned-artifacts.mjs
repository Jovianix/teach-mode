import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export async function downloadPinned(address, expected, destination) {
  if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error("A fixed SHA-256 is required");
  if (fs.existsSync(destination) && sha256(fs.readFileSync(destination)) === expected) return destination;
  let url = new URL(address); const origin = url.origin;
  const allowed = value => value.protocol === "https:" || value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname);
  let response;
  for (let hop = 0; hop <= 5; hop++) {
    if (!allowed(url) || url.username || url.password) throw new Error("Artifact URL must use HTTPS or loopback HTTP and must not contain credentials");
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: process.env.MEMMY_ARTIFACT_READ_TOKEN && url.origin === origin ? { authorization: `Bearer ${process.env.MEMMY_ARTIFACT_READ_TOKEN}` } : {} });
    if ([301, 302, 303, 307, 308].includes(response.status)) { url = new URL(response.headers.get("location"), url); continue; }
    break;
  }
  if (!response?.ok) throw new Error(`Artifact download failed: HTTP ${response?.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error("Artifact exceeds download limit"); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== expected) throw new Error("Artifact SHA-256 mismatch");
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
  return destination;
}
export async function extractPinned(file, directory) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file)); let total = 0;
  const entries = Object.entries(zip.files);
  if (entries.length > 10_000) throw new Error("Artifact has too many entries");
  fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true });
  for (const [name, entry] of entries) {
    const relative = path.relative(directory, path.resolve(directory, name));
    if (path.isAbsolute(name) || name.includes("\\") || name.includes(":") || relative === ".." || relative.startsWith(".." + path.sep)
      || entry.unsafeOriginalName && entry.unsafeOriginalName !== name || (entry.unixPermissions & 0o170000) === 0o120000) throw new Error("Unsafe artifact entry");
    if (entry.dir) continue;
    const bytes = await entry.async("nodebuffer"); total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error("Artifact exceeds extracted-size limit");
    const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  return directory;
}
