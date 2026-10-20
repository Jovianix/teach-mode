# Legacy 0.1 Web → Notepad teaching

This document describes the retained legacy executor. Teach Mode 0.2 creates new
recordings through the conversation's Record and Replay and Host Skill Creator.
Its release does not expose this old panel or the former `teach_manage` capability.
See the repository README for the current flow; existing 0.1 skills continue to
call `teach_session` with their exact saved plan and independent result checks.

Windows MVP in the manually installed **Teach Mode** plugin. Open its panel from
the conversation toolbar or `/teach`; opening the panel does not start capture.
A parent teaching
session owns the collector lease across a Playwright web segment and the existing
native task video recorder. Computer History is not started, paused or resumed
implicitly. A running history or another task prevents teaching from starting.

1. Enter an HTTP(S) starting page and consent to recording. Use the dedicated
   browser window to demonstrate same-origin actions in a single tab.
2. Choose **Select web output** in Memmy, then click a paragraph or list item in
   the browser. Memmy keeps its selector, tag, surrounding heading, URL, text hash
   and screenshot. Selection is a control event, not a replayed click.
3. Choose **Switch to Notepad**. Paste/type the selected output into the new
   task-owned document and save with Ctrl+S. **Finish demonstration** checks the editor
   and the saved file and requires a complete native input recording. It then
   automatically exports the execution plan, skill and demonstration guide.
4. Choose **Run web → Notepad**. A fresh browser repeats the compiled web actions,
   reads the *current* selected content, passes `web.note_text` to the Notepad
   adapter, sends native input and Ctrl+S, then checks both editor and disk contents.
   Every run creates a separate output file. Existing notes are never overwritten.

`session.json` contains ordered segments and run status; `web/events.jsonl` keeps
raw event order; `plan.json` binds the web output to the desktop input, without a
frozen input value. Native recordings retain their own events, frame clock and
video. Plans and event streams are hashed and checked before execution. A crash
marks unfinished sessions/runs failed at startup and never restarts recording.
Closing a browser during its recording, unsupported actions and a stopped native
recorder fail the session. A sealed web window may be closed while demonstrating
the desktop segment. Cancellation stops execution and releases the collector lease.

## Automatic skill export and chat execution

The compiled `plan.json` is the common input to the executor and the artifact
exporter. Finishing a valid demonstration publishes:

```text
<session>/exports/<plan-sha256>/
  plan.json          Exact bytes of the validated execution plan
  SKILL.md           Trigger description and hash-bound teach_session invocation
  DEMONSTRATION.md   Web actions, output binding, Notepad operations and checks
  manifest.json      Session, runtime, OpenAdapt boundary and each file's SHA-256
```

The skill name is `teach-<session-uuid>`. The plugin publishes validated exports
to the Host's generic skill registry. SkillsLoader checks active contributions
on every prompt build, so the next chat turn discovers
the skill without restarting. An explicit `$teach-<session-uuid>` also loads it.
Workspace/builtin skill precedence and disabled-skill settings continue to apply.
Restricted project chats receive read access only to generated bundle directories.

When the user requests execution, the plugin's `teach_session` MCP capability checks the
export and exact plan hash, delegates to the existing executor, waits for the run
and returns independent UI/file verification results and the output file path.
Tool cancellation aborts the active run. Inspecting or discovering a skill does
not execute it. The tool does not choose a replacement automation strategy after
a failed run. Chat receives the current skill metadata and execution report;
raw video/evidence is not added to the prompt automatically.

An export failure is separate from recording/compilation failure: the plan remains
ready and runnable, `artifactExport.state` reports `failed`, and **Generate or retry
skill export** retries only the export. The same action backfills older sessions.
Repeated finish/export calls reuse an intact bundle. Temporary output directories
are never advertised. Missing, changed or deleted bundles disappear from discovery.
Deleting a teaching session deletes its exports as well.

**Download bundle and guide** downloads these four files as a ZIP. The bundle calls
the originating Memmy instance and references its retained local evidence; this
version does not import the bundle into another machine or provide a standalone
runner. Generated files may contain recorded URLs, selectors and non-secret input
values, just as the compiled plan does.

## OpenAdapt boundary

Locator and evidence concepts align with the OpenAdapt Flow integration. This
MVP uses **Memmy's scoped `memmy-web-notepad-v1` executor**, not Flow `compose/run`.
Flow handoffs require confirmed effect-bound parameters; a read-only extracted
paragraph does not meet that contract automatically. `openadaptAdmission` stays
`not_admitted`. This is not a generic desktop replay engine or a production
OpenAdapt admission. Existing native OpenAdapt exports keep their current format.

OpenAdapt Flow exposes skill/MCP emitters over its compiled bundles; Memmy reuses
that separation of executable representation and agent-facing description here.
This does not add a Python runtime to the desktop application or call Flow's
`emit-skill` on a Memmy plan. Actual Flow execution would require compiling and
qualifying the child bundles, validating output-to-input handoffs, and then
routing the invocation to a qualified Flow runner. Until that path is implemented
and validated, the generated skill explicitly selects `memmy-web-notepad-v1`
and retains `not_admitted`.

Supported web actions: ordinary clicks, scrolling, non-secret text fills and Enter/Tab.
Cross-origin navigation, new tabs, iframes, dialogs, downloads, password/file
input and ambiguous/changed output targets stop execution. The output locator
can tolerate changed paper text while retaining the same tag and heading; this
does not claim that arbitrary page layout changes are safe. Use the official
homepage as the start URL rather than a search engine for this version.

## Plugin interface

The Host invokes `teach_session` for chat and `teach_manage` for the isolated
teaching UI. Both use the resident MCP stdio worker; there is no dedicated
Teach HTTP endpoint in the main program. Execution requires `consent:true`,
`session_id` and the exact `plan_sha256`. The worker waits for completion and
returns the actual execution report.

UI actions include list, start, get, pick-output, desktop, finish, run, cancel,
export, bundle, preview, recording, video and delete. Downloads and video are
passed through Host-managed local artifacts. Shared collector, recorder, focus
and generated-skill operations use identity-bound Host services approved at
activation. The plugin never receives Host authentication credentials.

Disabling or uninstalling stops active work and withdraws skills. The Host keeps
`~/.memmy/plugin-data/teach-mode`, recordings and generated note files; enabling
or reinstalling restores validated contributions. Legacy data is validated and
copied on first enable, with the original retained as a backup.

Evidence stays local until explicitly deleted. The task child recording is
pinned after a successful demonstration; this prevents the existing 48-hour
task-video cleanup from breaking its evidence references. Run reports contain
the live output hash, saved-file hash and independent UI/file match results.
Modern Notepad uses UIA TextPattern/ValuePattern. Classic System32 Notepad can
use its exact Win32 `Edit` child (ID 15) when UIA exposes it only as a Pane; the
chosen editor backend is retained in the window binding. Both use native keyboard
input and verify the real document separately from the file readback.
