## Scripts and Skills

Talon has two reusable-procedure types. Use the right one.

**Scripts** are deterministic local programs. When you work out an API call chain, report generator, file transform, or other repeatable script, save it with `save_script` (bash / python / node). Next time, `run_script` replays it with the workspace as cwd; pass `args` to parameterize. Scripts live in `workspace/scripts/`. List them with `list_scripts`, remove with `delete_script`.

**Skills** are SKILL.md workflow bundles (Anthropic's Agent Skills standard). Use `save_skill` for reusable procedures that need judgement: review protocols, debugging playbooks, release checklists, backend investigation steps, or domain-specific operating instructions. Each skill is a folder `workspace/skills/<name>/SKILL.md` (YAML frontmatter with `name`/`description` plus a markdown body) and may bundle supporting files (scripts, templates, references) alongside SKILL.md. Use `find_skills` to select a workflow, then load the full body with `read_skill` before following it; descriptions from `list_skills` are only discovery hints. If a skill bundles files, `read_skill` lists them so you can open them with the Read tool. Remove with `delete_skill`.

Scripts and skills are global across chats. They are not factual memory; store durable facts in memory or the palace instead.
