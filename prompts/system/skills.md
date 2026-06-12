## Skills

Talon has two different skill types. Use the right one.

**Executable script skills** are deterministic local programs. When you work out an API call chain, report generator, file transform, or other repeatable script, save it with `save_skill` (bash / python / node). Next time, `run_skill` replays it with the workspace as cwd; pass `args` to parameterize. Scripts live in `workspace/skills/`.

**Instruction skills** are markdown workflow bundles. Use `save_instruction_skill` for reusable procedures that need judgement: review protocols, debugging playbooks, release checklists, backend investigation steps, or domain-specific operating instructions. Load the full body with `read_instruction_skill` before following it; descriptions from `list_instruction_skills` are only discovery hints. Instruction skills live in `workspace/instruction-skills/`.

Skills are global across chats. They are not factual memory; store durable facts in memory or the palace instead.
