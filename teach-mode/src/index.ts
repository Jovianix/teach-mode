import { migratePrototypePluginData } from "./prototype-migration.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import manifest from "../plugin.json" with { type: "json" };
import { createTeachPlugin } from "./plugin.js";
import { createConversationTeachPlugin } from "./conversation-plugin.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { HostInvoker } from "./host.js";

const server = new Server({ name: manifest.id, version: manifest.version }, { capabilities: { tools: {} } });
const rpc = server as unknown as { request(request: { method: string; params: Record<string, unknown> }, schema: z.ZodType): Promise<{ result: unknown }> };
const scope = new AsyncLocalStorage<string>();
const host: HostInvoker = async <T>(service: string, input: unknown) => (await rpc.request({ method: "memmy/host-service", params: { service, input, ...(scope.getStore() ? { callId: scope.getStore() } : {}) } }, z.object({ result: z.unknown() }))).result as T;
const legacy = process.platform === "win32" ? createTeachPlugin(host) : null;
const plugin = createConversationTeachPlugin(host);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const context = await host<{ dataDirectory: string; legacyDataDirectory?: string }>("plugin-context", {});
  migratePrototypePluginData(context.dataDirectory, context.legacyDataDirectory);
  await plugin.initialize();
  await legacy?.initialize();
  return { tools: [...manifest.capabilities.map(c => ({ name: c.id, description: c.description, inputSchema: c.inputSchema })),
    { name: "memmy_shutdown", description: "Host lifecycle shutdown", inputSchema: { type: "object" as const } }] };
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    if (request.params.name === "memmy_shutdown") { await plugin.shutdown(); await legacy?.shutdown(); return { content: [{ type: "text", text: "stopped" }] }; }
    if (request.params.name === "teach_session" && !legacy) throw new Error("Legacy Web to Notepad skills require Windows. Use Record and Replay and Skill Creator for macOS workflows.");
    const callId = request.params._meta?.["memmy/call-id"];
    const output = await scope.run(typeof callId === "string" ? callId : "", () => request.params.name === "teach_session"
      ? legacy!.invoke(request.params.name, request.params.arguments ?? {}, extra.signal)
      : plugin.invoke(request.params.name, request.params.arguments ?? {}));
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Teaching failed" }] }; }
});
let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await plugin.shutdown(); await legacy?.shutdown(); await server.close(); };
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.stdin.once("end", () => void shutdown());
await server.connect(new StdioServerTransport());
