type Row = Record<string, any>;

// Production identifies the application directly. Development Electron builds share an
// app ID, so use the enclosing window / web area and its recorder-issued identity.
const memmyId = "cn.memtensor.memmy";
const memmyWindow = /^(?:[+~] )?(?:AXWindow|AXWebArea|ControlType\.Window)\|[^|\n]*\|Memmy\|/m;
const recordingControlId = /^memmy-recording-(?:controls|move|stop|discard|continue|dismiss)$/;
const recordingRegion = new Set(["Conversation recording", "对话录制"]);

function controlNodes(event: Row): Row[] {
  const details = event.details ?? {};
  return [details.accessibility, details.origin, details.destination]
    .filter(Boolean).flatMap(node => [node, ...(Array.isArray(node.ancestors) ? node.ancestors : [])]);
}

function windowsRoot(event: Row): string | undefined {
  return event.accessibility?.nodes?.find((node: Row) =>
    node.controlType === "Window" && node.parentKey == null)?.name;
}

type Candidate = { index: number; window?: string; memmy: boolean; recorder: boolean };
export type DemonstrationScope = { host: Set<number>; controls: Set<number> };

/** Run over the complete recording so a raw lookup or a later page gets the same
 * decision as the timeline, even if the first snapshot is a delta. */
export function demonstrationScope(lines: Iterable<string>): DemonstrationScope {
  const host = new Set<number>(), controls = new Set<number>();
  const hostWindows = new Set<string>();
  const runs: Candidate[][] = [];
  const activeRuns = new Map<string, Candidate[]>();
  for (const line of lines) {
    if (!line) continue;
    const { index, source, event } = JSON.parse(line);
    const app = event.application ?? {};
    const bundle = String(app.bundleId ?? app.id ?? "").toLowerCase();
    const exe = String(app.executable ?? "").split(/[\\/]/).pop()?.toLowerCase();
    const stream = String(source?.stream ?? "");
    const packaged = bundle === memmyId || bundle === "win32.memmy" || exe === "memmy.exe";
    const generic = bundle === "com.github.electron" || bundle === "win32.electron" || exe === "electron.exe";
    if (!generic || app.memmyWindow === false) activeRuns.delete(stream);
    if (!packaged && (!generic || app.memmyWindow === false)) continue;
    const nodes = controlNodes(event);
    const recorder = nodes.some(node => recordingControlId.test(node.identifier ?? "")
      || (recordingRegion.has(node.description ?? node.name) && (node.subrole === "AXLandmarkRegion" || node.role === "region")));
    if (packaged) {
      host.add(index);
      if (recorder) controls.add(index);
      continue;
    }
    const winRoot = windowsRoot(event);
    const memmy = app.memmyWindow === true || recorder || memmyWindow.test(event.ax?.text ?? "") || winRoot === "Memmy"
      || nodes.some(node => ["AXWindow", "AXWebArea"].includes(node.role) && node.title === "Memmy");
    const details = event.details ?? {};
    const windowKey = event.ax?.windowKey
      ?? (details.hwnd && details.pid ? [details.pid, details.processStart, details.hwnd].join(":") : undefined);
    const window = windowKey && JSON.stringify([stream, windowKey]);
    if (memmy && window) hostWindows.add(window);
    let run = activeRuns.get(stream);
    if (!run || event.eventType === "application_changed") {
      run = []; runs.push(run); activeRuns.set(stream, run);
    }
    run.push({ index, window, memmy, recorder });
  }
  for (const run of runs) {
    // Native clicks often omit a window key. Associate those only within one
    // foreground run with a positively identified Memmy window and no other window.
    const onlyHost = run.some(row => row.memmy || (row.window && hostWindows.has(row.window)))
      && run.every(row => !row.window || hostWindows.has(row.window));
    for (const row of run) {
      if (!row.memmy && !(row.window && hostWindows.has(row.window)) && !(onlyHost && !row.window)) continue;
      host.add(row.index);
      if (row.recorder) controls.add(row.index);
    }
  }
  return { host, controls };
}
