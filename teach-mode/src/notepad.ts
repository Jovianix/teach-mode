import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TeachNotepadTargetSchema, type TeachNotepadTarget } from "./contracts.js";

export interface TeachNotepad {
  open(file: string, signal?: AbortSignal): Promise<TeachNotepadTarget>;
  read(target: TeachNotepadTarget, signal?: AbortSignal): Promise<string>;
  writeAndSave(target: TeachNotepadTarget, text: string, signal?: AbortSignal): Promise<void>;
}
/** Only newly created, task-owned documents are accepted by this adapter. */
export class WindowsTeachNotepad implements TeachNotepad {
  constructor(private readonly focus: (pid: number, hwnd: string) => Promise<unknown>) {}
  private invoke(request: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    if (process.platform !== "win32") return Promise.reject(new Error("teach_requires_windows"));
    return new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        fileURLToPath(new URL("./notepad-control.ps1", import.meta.url))], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal });
      let stdout = "", overflow = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error("teach_notepad_timeout")); }, 60_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 256_000) { overflow = true; child.kill(); } });
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.stdin.on("error", () => {});
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          if (overflow || code !== 0) throw new Error("teach_notepad_control_failed");
          const value = JSON.parse(stdout.trim().replace(/^\uFEFF/u, ""));
          if (!value.ok) throw new Error(typeof value.error === "string" ? value.error : "teach_notepad_control_failed");
          resolve(value);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(request) + "\n");
    });
  }
  async open(file: string, signal?: AbortSignal): Promise<TeachNotepadTarget> {
    const target = TeachNotepadTargetSchema.parse((await this.invoke({ op: "open", file }, signal)).target);
    signal?.throwIfAborted(); await this.focus(target.pid, target.hwnd);
    await this.invoke({ op: "focus", target }, signal);
    return target;
  }
  async read(target: TeachNotepadTarget, signal?: AbortSignal): Promise<string> {
    const value = await this.invoke({ op: "read", target }, signal);
    if (typeof value.text !== "string" || value.text.length > 20002) throw new Error("teach_notepad_readback_invalid");
    return value.text;
  }
  async writeAndSave(target: TeachNotepadTarget, text: string, signal?: AbortSignal): Promise<void> {
    if (!text || text.length > 20000) throw new Error("teach_note_text_invalid");
    signal?.throwIfAborted(); await this.focus(target.pid, target.hwnd);
    await this.invoke({ op: "write", target, text }, signal);
  }
}
