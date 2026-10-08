# Confirmed project baseline

The user confirmed this chat's Print Chamber 0.1.1 implementation as the future direction on 2026-10-07.
Read BASELINE.txt and baselines/print-chamber-0.1.1-20261007/manifest.json before changing implementation files.

- Treat baselines/print-chamber-0.1.1-20261007 as an archival snapshot. Do not edit or regenerate it in place. Create a new explicitly named version for subsequent accepted baselines.
- Do not merge experiments from other chats into the active extension, service, prompt, or baseline without explicit user authorization to adopt those experiments.
- Keep other-chat experiments in separate directories or worktrees. In particular, design-preview/ and start-design-preview.command are outside this baseline and must not replace its implementation.
- Current default: on 2026-10-07, after the D comparison, the user explicitly authorized replacing benchmark_local.py PROMPT with their exact D text (output/eight-ab-20261007-174824/metrics.json, prompts.B). This supersedes earlier instructions to retain the old generic prompt in active code. Preserve the old archival snapshot. Rejected v2/v3 and experimental B/C prompts remain excluded.
- Before authorized changes, compare the current files with the snapshot manifest. Preserve unexplained concurrent changes; do not silently overwrite them.
- Preserve the test limitation: live ArtStation artwork pages have not been verified; simulated cards and the local gallery passed. Do not label the live-site issue resolved without new evidence.

Explicit later user instructions take precedence over these baseline rules.

## Authorized visual replacement (0.2.0 work in progress)

On 2026-10-07 the user explicitly requested exact reproduction of
`/Users/abelguan/Downloads/Print Chamber 设计稿.html` across the extension UI.
The source is preserved in `design-reference/original.html`; extracted templates
and bundled fonts are the only design source for this change. `build-design.cjs`
compiles the printer markup, popup and gallery from those templates.
The old 0.1.1 snapshot remains immutable. This new working version is not a newly
accepted baseline until the user confirms it. The later authorized D prompt
replacement above is independent of UI baseline acceptance. Do not import
`design-preview/` or other-chat experiments.
