# Skills

Skills are reusable workflow bundles for procedures that need judgement. They
follow Anthropic's Agent Skills (SKILL.md) standard. They are distinct from
executable scripts and from factual memory.

## Storage

- Scripts: executable programs in `workspace/scripts/`, created with
  `save_script`, run with `run_script`.
- Skills: SKILL.md bundles in `workspace/skills/<name>/SKILL.md`, created with
  `save_skill`, selected with `find_skills`, loaded with `read_skill`.
- Facts, preferences, and history: `memory/memory.md`, MemPalace, and daily
  notes, not skills.

### Skill layout (SKILL.md standard)

Each skill is a **folder** under `workspace/skills/<name>/` whose entry file is
`SKILL.md`:

```
workspace/skills/<name>/
  SKILL.md          # YAML frontmatter + markdown body
  helper.py         # optional bundled resource
  template.md       # optional bundled resource
```

`SKILL.md` opens with YAML frontmatter. Required keys are `name` and
`description`; optional keys (e.g. `license`, `metadata`, `allowed-tools`) are
tolerated and preserved on read. The markdown body follows the closing `---`.

```markdown
---
name: review-pr
description: review pull requests carefully
---

## Steps

1. Read the diff.
2. Run tests.
```

**Bundled resources.** A skill folder may contain supporting files (scripts,
templates, references) alongside `SKILL.md`. `save_skill` overwrites only
`SKILL.md` and never touches sibling files, so updates preserve bundled
resources. `read_skill` enumerates them and tells the agent to open them with
the normal Read tool. Deleting a skill removes the whole folder.

## Loading Policy

The system prompt injects only a capped skill index: name, description, and
updated date. Full bodies stay on disk until needed.

Agents should:

1. Use the prompt index when the relevant workflow is obvious.
2. Use `find_skills` when the task needs relevance selection.
3. Call `read_skill` before following a selected workflow.
4. Create or update a skill when a repeatable process is learned.

This keeps startup context small while preserving progressive disclosure.

## Backend Adapter Model

Talon does not depend on provider-native skill support. The adapter layer is the
shared prompt and shared gateway tools:

- Claude SDK receives the skill index after the dynamic cache boundary and
  exposes the same MCP tools.
- Codex receives the same prompt text and tool definitions through its MCP
  server config.
- Kilo and OpenCode receive the same prompt and shared gateway actions through
  the remote-server backend path.
- OpenAI Agents receives the same prompt and tool surface through the Responses
  backend.

If a backend later gains native skills, it can mirror
`workspace/skills/<name>/SKILL.md` into that native format, but the SKILL.md
store remains the source of truth so workflows are portable across backends.

## Migration Boundary

`save_script` entries remain executable scripts. Do not auto-convert them:
scripts encode deterministic subprocess behavior, while skills encode
review/checklist/debugging guidance. A script can reference a skill in its
description, and a skill can tell the agent to run a script, but they stay
separate artifacts.
