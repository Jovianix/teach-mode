import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { TeachWebActionSchema, TeachUrlSchema, type TeachWebAction, type TeachLocator, type TeachOutput } from "./contracts.js";

export interface TeachBrowser {
  start(url: string, directory: string, onAction: (action: TeachWebAction) => Promise<void>): Promise<void>;
  pick(): Promise<void>;
  read(locator: TeachLocator, expectedUrl: string): Promise<{ text: string; url: string }>;
  screenshot(file: string): Promise<void>;
  seal(): Promise<void>;
  replay(url: string, actions: TeachWebAction[], signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  failureReason?(): string | null;
}
export const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
export const normalizeNote = (value: string) => value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trimEnd();
export function assertTeachUrl(value: string, origin?: string): string {
  const url = TeachUrlSchema.parse(value);
  if (origin && new URL(url).origin !== origin) throw new Error("teach_cross_origin_navigation_refused");
  return url;
}
/** A task owns its entire browser context; no existing user's tabs are attached or closed. */
export class PlaywrightTeachBrowser implements TeachBrowser {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private process: ChildProcess | null = null;
  private page: Page | null = null;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private recording = false;
  private sequence = 0;
  private started = 0;
  constructor(private readonly options: { channel?: "msedge" | "chrome" | "chromium"; headless?: boolean; executablePath?: string } = {}) {}
  private current(): Page { if (!this.page || this.page.isClosed()) throw new Error("teach_browser_closed"); return this.page; }
  private checked(): void { if (this.failure) throw this.failure; }
  failureReason(): string | null { return this.failure?.message ?? (this.page?.isClosed() ? "teach_browser_closed" : null); }
  private async settled(): Promise<void> {
    await this.current().waitForLoadState("domcontentloaded");
    // Network-idle never settles on some ordinary sites. Layout readiness is bounded.
    await this.current().waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
    this.checked();
  }
  private async launchWindows(directory: string, channel: "msedge" | "chrome"): Promise<BrowserContext> {
    const candidates = channel === "msedge" ? [path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe")]
      : [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")];
    const executable = this.options.executablePath ?? candidates.find(file => fs.existsSync(file));
    if (!executable) throw new Error("teach_browser_not_installed");
    const profile = path.join(directory, "browser-profile"); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    // Some deployed Edge versions never finish Playwright's pipe startup. A
    // task-owned loopback CDP process also gives recording and execution the
    // same explicit browser lifetime and prevents attachment to unrelated tabs.
    this.process = spawn(executable, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      "--no-first-run", "--no-default-browser-check", "--force-renderer-accessibility", "--new-window", "about:blank"],
    { windowsHide: false, stdio: "ignore", shell: false });
    if (this.process.pid) {
      // This narrowly bound watcher survives an unexpected worker crash. It
      // can terminate only the browser carrying this task's unique profile.
      const guardian = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./browser-guardian.ps1", import.meta.url)),
          "-ParentProcessId", String(process.pid), "-BrowserProcessId", String(this.process.pid), "-Profile", profile],
        { windowsHide: true, detached: true, stdio: "ignore", shell: false });
      guardian.on("error", () => {}); guardian.unref();
    }
    let processError: Error | null = null;
    this.process.on("error", error => { processError = error; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (processError) throw processError;
      try {
        const file = path.join(profile, "DevToolsActivePort");
        if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) {
          const port = Number(fs.readFileSync(file, "utf8").split("\n")[0]);
          if (Number.isInteger(port) && port > 0 && port <= 65535) {
            this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
            const contexts = this.browser.contexts();
            if (contexts.length !== 1 || contexts[0]!.pages().length > 1) throw new Error("teach_browser_surface_not_unique");
            return contexts[0]!;
          }
        }
      } catch (error) { if (error instanceof Error && error.message === "teach_browser_surface_not_unique") throw error; }
      await delay(150);
    }
    throw new Error("teach_browser_start_timeout");
  }
  async start(url: string, directory: string, onAction: (action: TeachWebAction) => Promise<void>): Promise<void> {
    const origin = new URL(assertTeachUrl(url)).origin;
    const channel = this.options.channel ?? (process.platform === "win32" ? "msedge" : "chromium");
    this.context = process.platform === "win32" && !this.options.headless && channel !== "chromium"
      ? await this.launchWindows(directory, channel) : await chromium.launchPersistentContext(path.join(directory, "browser-profile"), {
      ...(channel !== "chromium" ? { channel } : {}), ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      headless: this.options.headless ?? false, viewport: { width: 1280, height: 800 },
      acceptDownloads: false, serviceWorkers: "block",
    });
    this.context.setDefaultTimeout(10_000);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    const fail = (reason: string) => { this.failure ??= new Error(reason); };
    this.context.on("page", () => fail("teach_new_tab_refused"));
    this.page.on("crash", () => fail("teach_browser_crashed"));
    this.page.on("dialog", dialog => { fail("teach_browser_dialog_refused"); void dialog.dismiss(); });
    this.page.on("download", download => { fail("teach_browser_download_refused"); void download.cancel(); });
    this.page.on("framenavigated", frame => { if (frame !== this.page?.mainFrame() && frame.url() !== "about:blank") fail("teach_iframe_refused"); });
    await this.context.route("**/*", async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame()) {
        try { assertTeachUrl(request.url(), origin); }
        catch { fail("teach_cross_origin_navigation_refused"); await route.abort(); return; }
      }
      await route.continue();
    });
    this.recording = true; this.started = performance.now();
    await this.context.exposeBinding("__memmyTeachSend", async ({ page, frame }, value: unknown) => {
      if (!this.recording || page !== this.page || frame !== page.mainFrame()) return;
      this.tail = this.tail.then(async () => {
        const action = TeachWebActionSchema.parse({ ...(value as object), sequence: ++this.sequence, timeMs: performance.now() - this.started });
        assertTeachUrl(action.url, origin);
        await onAction(action);
        if (action.type === "unsupported") fail(`teach_${action.value ?? "unsupported_action"}`);
      }).catch(error => { this.failure ??= error instanceof Error ? error : new Error("teach_browser_capture_failed"); });
      await this.tail;
    });
    await this.context.addInitScript({ content: fs.readFileSync(new URL("./browser-recorder.js", import.meta.url), "utf8") });
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.settled();
  }
  async pick(): Promise<void> {
    this.checked(); await this.current().bringToFront();
    await this.current().evaluate("window.__memmyTeach.pick()");
  }
  async read(locator: TeachLocator, expectedUrl: string): Promise<{ text: string; url: string }> {
    await this.settled();
    if (this.current().url() !== expectedUrl) throw new Error("teach_output_page_changed");
    const node = this.current().locator(locator.selector);
    if (await node.count() !== 1 || !await node.isVisible()) throw new Error("teach_output_not_unique_or_visible");
    await node.scrollIntoViewIfNeeded();
    const result = await node.evaluate((element: any) => ({ tag: element.tagName.toLowerCase(), text: element.innerText,
      heading: (globalThis as any).__memmyTeach?.heading(element) ?? "", editable: !!element.closest('input,textarea,[contenteditable="true"]') }));
    if (result.editable || result.tag !== locator.tag || (locator.heading && result.heading !== locator.heading)) throw new Error("teach_output_context_changed");
    const text = String(result.text ?? "").trim();
    if (!text || text.length > 20000) throw new Error("teach_output_empty_or_too_large");
    return { text, url: this.current().url() };
  }
  async screenshot(file: string): Promise<void> { this.checked(); await this.current().screenshot({ path: file }); }
  async seal(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.page.evaluate("window.__memmyTeach?.disable()");
    await this.tail; this.recording = false; this.checked();
  }
  async replay(url: string, actions: TeachWebAction[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.recording = false;
    await this.current().goto(url, { waitUntil: "domcontentloaded" });
    await this.current().evaluate("window.__memmyTeach?.disable()");
    for (const action of actions) {
      signal.throwIfAborted(); this.checked();
      if (["navigation", "output"].includes(action.type)) continue;
      if (action.type === "scroll" && /^\d{1,7},\d{1,7}$/u.test(action.value ?? "")) {
        const [x, y] = action.value!.split(",").map(Number);
        await this.current().evaluate(`window.scrollTo(${x},${y})`); await this.settled(); continue;
      }
      if (action.type === "unsupported" || !action.locator) throw new Error("teach_web_action_unsupported");
      // Event URLs describe pre-action state. Refuse silent action retargeting.
      if (this.current().url() !== action.url) throw new Error("teach_web_action_page_changed");
      const node = this.current().locator(action.locator.selector);
      if (await node.count() !== 1 || !await node.isVisible()) throw new Error("teach_web_target_not_unique_or_visible");
      if (await node.evaluate((element: any) => element.tagName.toLowerCase()) !== action.locator.tag) throw new Error("teach_web_target_changed");
      if (action.type === "click") await node.click();
      else if (action.type === "fill") await node.fill(action.value ?? "");
      else if (action.type === "press" && action.value && /^(Control\+)?(Shift\+)?(Enter|Tab)$/u.test(action.value)) await node.press(action.value);
      else throw new Error("teach_web_action_unsupported");
      await this.settled();
      await this.current().evaluate("window.__memmyTeach?.disable()");
    }
    signal.throwIfAborted(); this.checked();
  }
  async close(): Promise<void> {
    this.recording = false; await this.tail;
    const context = this.context, browser = this.browser, child = this.process;
    this.context = null; this.page = null; this.browser = null; this.process = null;
    try {
      if (browser && context?.pages()[0]) {
        const connection = await context.newCDPSession(context.pages()[0]!);
        await connection.send("Browser.close").catch(() => {});
        await browser.close().catch(() => {});
      } else await context?.close();
    } finally { if (child && child.exitCode === null) child.kill(); }
  }
}

export function compileTeachWebActions(actions: TeachWebAction[], output: TeachOutput): TeachWebAction[] {
  if (!actions.some(action => action.type === "output" && action.locator?.selector === output.locator.selector)) throw new Error("teach_output_evidence_missing");
  if (actions.some(action => action.type === "unsupported")) throw new Error("teach_web_actions_incomplete");
  const compiled: TeachWebAction[] = [];
  for (const action of actions) {
    if (["navigation", "output"].includes(action.type)) continue;
    if (action.type === "scroll" && /^\d{1,7},\d{1,7}$/u.test(action.value ?? "")) { compiled.push(action); continue; }
    if (!action.locator) throw new Error("teach_web_target_missing");
    const previous = compiled.at(-1);
    if (action.type === "fill" && previous?.type === "fill" && previous.url === action.url && previous.locator?.selector === action.locator.selector) compiled[compiled.length - 1] = action;
    else compiled.push(action);
  }
  return compiled;
}
