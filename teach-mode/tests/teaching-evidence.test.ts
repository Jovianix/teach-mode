import { describe, expect, it } from "vitest";
import { teachingEvidence } from "../src/teaching-evidence.js";

const row = (index: number, event: Record<string, unknown>) => ({ index, source: { stream: "one", sequence: index + 1 },
  event: { eventType: "text_input", timestamp: `2026-10-25T12:00:${String(index).padStart(2, "0")}Z`, ...event } });
const page = (events: unknown[], nextOffset: number | null = null) => ({
  session: { eventsSha256: "a".repeat(64), availability: "partial", limitations: ["capture gap"] }, events, nextOffset });

describe("derived teaching evidence", () => {
  it("retains raw indices, semantic values, unknown fields and integrity metadata without changing input", () => {
    const original = page([row(17, { details: { nativeSessionId: "diagnostic", hwnd: "42", text: "invoice 2026", redacted: false, truncation: ["partial"] }, custom: { value: "keep" } })]);
    const before = JSON.stringify(original), result = teachingEvidence(original);
    expect(result).toMatchObject({ session: original.session, evidenceView: "teaching", nextOffset: null,
      events: [{ index: 17, source: { stream: "one", sequence: 18 }, custom: { value: "keep" },
        details: { hwnd: "42", text: "invoice 2026", redacted: false, truncation: ["partial"] } }] });
    expect(result.events[0]!.details).not.toHaveProperty("nativeSessionId");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("groups only equivalent adjacent redacted presses, retaining every original index and window boundary", () => {
    const events = [row(20, { details: { redacted: true, hwnd: "1", actionIndex: 0 } }),
      row(21, { details: { redacted: true, hwnd: "1", actionIndex: 1 } }),
      row(22, { details: { redacted: true, hwnd: "2" } }),
      row(23, { details: { redacted: true, hwnd: "2", text: "literal" } }),
      row(24, { eventType: "key_press", details: { keys: ["CTRL", "S"] } })];
    const result = teachingEvidence(page(events));
    expect(result.events.map(event => event.index)).toEqual([20, 22, 23, 24]);
    expect(result.events[0]).toMatchObject({ groupedIndexes: [20, 21], lastSource: { sequence: 22 }, through: events[1]!.event.timestamp });
    expect(result.evidenceNotes.groupedRawEvents).toBe(1);
    expect(result.events[2]!.details.text).toBe("literal");
  });

  it("does not group an unknown semantic field into a later ordinary redacted press", () => {
    const result = teachingEvidence(page([row(0, { details: { redacted: true }, custom: "context" }),
      row(1, { details: { redacted: true } })]));
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.custom).toBe("context");
    expect(result.events[1]).not.toHaveProperty("custom");
  });

  it("preserves redaction and snapshot completeness while omitting hidden content and empty structure", () => {
    const result = teachingEvidence(page([row(8, { eventType: "accessibility_snapshot", accessibility: {
      mode: "full", truncated: true, nodes: [
        { key: "a", parentKey: null, controlType: "Pane", name: "" },
        { key: "b", controlType: "Document", text: "visible note", visibleText: "visible note", documentStatus: "available" },
        { controlType: "Edit", redaction: "password", text: "do not reveal" },
        { controlType: "Text", providerOffscreen: true, name: "hidden content" },
      ] } })]));
    expect(result.events[0]!.accessibility).toMatchObject({ truncated: true, omittedEmptyNodes: 1, omittedHiddenNodes: 1,
      nodes: [{ controlType: "Document", text: "visible note", visibleTextEqualsText: true, documentStatus: "available" },
        { controlType: "Edit", redaction: "password" }] });
    expect(JSON.stringify(result)).not.toMatch(/do not reveal|hidden content/);
  });

  it("paginates at the next original index without skipping or renumbering events", () => {
    const events = Array.from({ length: 20 }, (_, i) => row(30 + i, { details: { text: "value ".repeat(20) } }));
    const first = teachingEvidence(page(events, 50), 1_000);
    expect(first.nextOffset).toBe(30 + first.events.length);
    expect(JSON.stringify(first.events).length).toBeLessThanOrEqual(1_000);
    const rest = teachingEvidence(page(events.slice(first.events.length), 50), 20_000);
    expect([...first.events, ...rest.events].map(event => event.index)).toEqual(events.map(event => event.index));
    expect(rest.nextOffset).toBe(50);
  });

  it("explicitly requires raw access for oversized events instead of pretending they were fully read", () => {
    const result = teachingEvidence(page([row(0, { details: { text: "x".repeat(30_000) } }), row(1, { details: { text: "small" } })]), 1_000);
    expect(result.events[0]).toMatchObject({ index: 0, rawRequired: true });
    expect(result.events[1]!.details.text).toBe("small");
    expect(result.nextOffset).toBeNull();
    expect(result.evidenceNotes.rawAccess).toContain("limit=1");
  });
});
