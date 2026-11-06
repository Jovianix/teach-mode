export type HostService = "plugin-context" | "event-sessions" | "skills";
export type HostInvoker = <T = unknown>(service: HostService, input: unknown) => Promise<T>;
