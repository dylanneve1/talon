# Instruction Skills

Instruction skills are Talon-native markdown workflow bundles for reusable
procedures that need judgement. They are distinct from executable script skills
and from factual memory.

## Storage

- Executable scripts: `workspace/skills/`, created with `save_skill`, run with
  `run_skill`.
- Instruction skills: `workspace/instruction-skills/*.md`, created with
  `save_instruction_skill`, selected with `find_instruction_skills`, loaded
  with `read_instruction_skill`.
- Facts, preferences, and history: `memory/memory.md`, MemPalace, and daily
  notes, not instruction skills.

## Loading Policy

The system prompt injects only a capped instruction-skill index: name,
description, and updated date. Full bodies stay on disk until needed.

Agents should:

1. Use the prompt index when the relevant workflow is obvious.
2. Use `find_instruction_skills` when the task needs relevance selection.
3. Call `read_instruction_skill` before following a selected workflow.
4. Create or update an instruction skill when a repeatable process is learned.

This keeps startup context small while preserving progressive disclosure.

## Backend Adapter Model

Talon does not depend on provider-native skill support. The adapter layer is the
shared prompt and shared gateway tools:

- Claude SDK receives the instruction-skill index after the dynamic cache
  boundary and exposes the same MCP tools.
- Codex receives the same prompt text and tool definitions through its MCP
  server config.
- Kilo and OpenCode receive the same prompt and shared gateway actions through
  the remote-server backend path.
- OpenAI Agents receives the same prompt and tool surface through the Responses
  backend.

If a backend later gains native skills, it can mirror
`workspace/instruction-skills/*.md` into that native format, but the markdown
store remains the source of truth so workflows are portable across backends.

## Migration Boundary

Existing `save_skill` entries remain executable scripts. Do not auto-convert
them: scripts encode deterministic subprocess behavior, while instruction skills
encode review/checklist/debugging guidance. A script can reference an
instruction skill in its description, and an instruction skill can tell the agent
to run a script, but they stay separate artifacts.
