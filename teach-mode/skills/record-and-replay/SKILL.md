---
name: record-and-replay
description: Record a demonstration, stop or discard the recording, and turn the completed workflow into a reusable skill.
---

# Record and Replay

Use the active plugin's `record_and_replay` capability in the current conversation.

- When the user is ready, call `start` with a short workflow goal. Set `include_memmy:true` only when the user intends to demonstrate work in Memmy itself. Recorder controls are excluded from the teaching evidence. The App asks the user to confirm before collecting events. A bare request to open the plugin can be answered with a short invitation to start. When the user only authorizes one tab or window, first explain that recording uses the existing Computer History scope.
- After a successful start, tell the user they can demonstrate now, have up to 30 minutes, and can say “录制完成” when done. End the turn. Never poll or wait for completion. For a declined start, acknowledge it and end the turn.
- Chrome, Edge and other applications use the same authorized Computer History stream. Do not call `browser_list_tabs`, open a teaching window, require an extension, or start video capture. If another recording is active, leave it running. Surface actual permission or startup errors.
- The floating Stop control ends capture and preserves the recording. Discard cancels it. A discarded or failed session cannot be used to create a skill. Honor a request to stop without generating.
- When the user says the demonstration is complete, use the session from this conversation. Call `status` only if the state or ID is unclear. Call `stop` if still recording. If the controls already stopped it, use that ready session. If cancelled or empty, end here. Never silently select an older recording after a cancellation.
- Continue in the same turn with the Host Skill Creator via `$teach-skill-creator` and the ready session ID. By default create a reusable skill or refine the skill the user identified. Ask only when uncertainty about the goal, outcome or parameters would change the result. Do not ask for blanket approval just because capture is partial.
- Report a concise summary of the saved workflow, inputs and important assumptions. Execute the resulting skill only on a later user request.
