---
name: teach-mode
description: Use Teach Mode in the conversation to record computer events and create a reusable skill, or run a retained legacy web-to-Notepad skill.
---

For new teaching, follow `$record-and-replay` and then, only on a separate user
generation request, `$teach-skill-creator`. `/teach` loads the conversation skill;
it does not open a panel or start capture. New recordings use the authorized
Computer History event scope and impose no particular application combination.

On Windows, the plugin's `teach_session` capability remains available to inspect and run
retained 0.1 web-to-Notepad demonstrations when the user requests those old skills.
macOS uses the conversation skills above; Windows legacy execution is unavailable.

Generated `teach-<uuid>` skills contain the exact invocation tool name, session ID
and plan hash. Run only when the user requests execution. Report success only
after the returned run succeeded and both UI and saved-file verification passed.
Return the actual output file. Do not substitute a different automation or retry
writes after a failed execution. Recording and evidence remain on this computer.
