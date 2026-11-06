# Conversation Teach Mode

The plugin exposes `record_and_replay` and `create_skill`. Both Windows and macOS
use the same conversation flow; the Host supplies desktop Computer History and
Chrome/Edge extension events through `event-sessions`.

- `index.ts` owns MCP routing and process shutdown. It copies validated prototype
  data before initializing the conversation plugin.
- `host.ts` limits plugin calls to `plugin-context`, `event-sessions`, and `skills`.
- `conversation-plugin.ts` requests event capture, prepares evidence for the Host
  Skill Creator, validates drafts, and saves/registers generated skills.
- `teaching-evidence.ts` provides a compact view while preserving raw event indices.
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
Ending event capture does not generate a skill; generation requires a separate
request. Saving a skill does not prove that a later execution succeeds.
