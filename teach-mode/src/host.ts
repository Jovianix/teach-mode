import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { TeachNotepadTarget } from "./contracts.js";

export type HostInvoker = <T = unknown>(service: string, input: unknown) => Promise<T>;
export interface TeachCollector { acquire(): Promise<() => Promise<void>> }
export interface TeachRecording { id: string; state: string; timelineCompleteness: string; eventCount?: number }
export interface TeachRecordings {
  directory: string;
  start(input: unknown, unused: null, target: Pick<TeachNotepadTarget, "pid" | "hwnd" | "processStart">): Promise<TeachRecording>;
  get(id: string): Promise<TeachRecording>;
  control(id: string, action: "stop"): Promise<TeachRecording>;
  pin(id: string, value: boolean): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  openMedia(id: string, mediaId: string): Promise<{ path: string; type: string; size: number }>;
  shutdown(): Promise<void>;
}
export class RecordingError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function createHostAdapters(host: HostInvoker, directory: string) {
  let leaseId: string | null = null;
  const gate: TeachCollector = { async acquire() {
    const lease = await host<{ leaseId: string }>("collector", { action: "acquire" }); leaseId = lease.leaseId;
    let released = false;
    return async () => {
      if (released) return;
      await host("collector", { action: "release", leaseId: lease.leaseId }); released = true;
      if (leaseId === lease.leaseId) leaseId = null;
    };
  } };
  const recordings: TeachRecordings = {
    directory: path.join(directory, "recordings"),
    start: (input, _unused, target) => host("recording", { action: "start", recording: input, target, leaseId }),
    get: id => host("recording", { action: "get", id }),
    control: (id, action) => host("recording", { action, id }),
    pin: (id, value) => host("recording", { action: "pin", id, value }),
    delete: id => host("recording", { action: "delete", id }),
    openMedia: id => host("recording", { action: "media", id }),
    shutdown: async () => {}
  };
  return { gate, recordings };
}
