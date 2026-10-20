---
name: record-and-replay
description: Record, inspect, finish, or cancel the user's upcoming computer operations in this conversation. Use when asked to record or teach an actual workflow in any authorized application, or to stop the current recording.
---

# Record and Replay

Use the active Teach Mode plugin's `record_and_replay` capability. Keep all
instructions, consent, status and results in the current conversation. Do not
open a separate teaching panel or require a starting URL or a particular app.

1. For a bare invocation such as `/teach` or `$record-and-replay`, explain that
   recording covers the existing authorized Computer History event scope and
   stays on this PC. Wait for the user to ask to start. Never start merely by
   listing or opening the capability.
2. When the user explicitly requests recording, identify the goal, explain the
   scope if not already explained, and call `start` with that goal and
   `consent:true`. Report recording only after the returned state is `recording`.
   Permission, collector and dependency errors must remain visible in chat.
3. Call `status` to recover the current conversation's sessions after a refresh
   or uncertain state. The Host shares the existing collector: do not pause
   Computer History or start a second recorder. The conversation status strip
   offers end/cancel controls and reflects the actual session.
4. On a request to finish, resolve the current session and call `stop` with its
   `session_id`. Explain its time range, event count, availability and missing
   observations. An empty or partial fragment does not prove a successful task.
   Say that recording has ended and the user may now request skill generation.
   Do not call Skill Creator automatically. `cancel` keeps an explicitly cancelled
   fragment; cancelled/failed fragments are not eligible for generation.
5. Only after a separate user request to generate a skill, use
   `$teach-skill-creator` and the selected recording ID. Multiple candidates require
   clarification when the intended recording is ambiguous.

Recording does not require video and does not promise generic desktop replay.
Later execution uses the generated instructions and available Agent tools, only
when the user requests it, with independent checks of the actual task result.
To disable or re-enable Teach Mode, use the Host `plugin_manage` tool. Uninstall
belongs to the plugin management page; user evidence and skills are retained.
