# Conversation Teach Mode

The plugin exposes `record_and_replay` and `create_skill`. Both Windows and macOS
use the same conversation flow; the Host supplies Computer History through
`event-sessions` for every app, including Chrome and Edge. A connected
extension can enrich the same stream when the observation policy allows it.

- `index.ts` owns MCP routing and process shutdown. It copies validated prototype
  data before initializing the conversation plugin.
- `host.ts` limits plugin calls to `plugin-context`, `event-sessions`, and `skills`.
- `conversation-plugin.ts` requests event capture, prepares evidence for the Host
  Skill Creator, validates drafts, and saves/registers generated skills.
- `demonstration-scope.ts` identifies Memmy and its recording controls for both
  evidence views and validates the scope of references at save time. Original
  Computer History events and their indices are preserved.
- `teaching-evidence.ts` derives compact timeline entries and the action text a
  step may cite as observed. The creator can supply reusable replay instructions separately.
- The `create_skill` manifest uses a JSON Schema dependency on `action` for its
  save-only required fields. This keeps the Host MCP tool's existing flat arguments.
  Prepare returns those arguments with the ID and hash.
- `prototype-migration.ts` retains the original data directory while activating a
  validated copy of event sessions and generated skills.
- `legacy-skill-retirement.ts` withdraws old Web → Notepad skill registrations
  before the Host activates its generated skill index. It recognizes the old
  export metadata and never deletes skill, evidence, or video files.

Teach Mode 0.5.0 removes `teach_session`, the old `teach_manage` implementation,
its Playwright/Notepad executor, and the plugin video-recording adapter. No old
executor or panel is packaged. Existing legacy `outputDirectory` config has no
runtime use; removing that config schema lets the Host accept upgrades with a
retained config object without exposing the retired setting.

The App's user-initiated task recording remains a separate feature. System screen
recording permission may remain granted. Teach never starts video capture.
Stopping from the controls retains the recording. Reporting completion in chat hands it to Skill Creator. Saving a skill does not prove that a later execution succeeds.
