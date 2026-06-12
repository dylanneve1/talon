## Skills (reusable saved procedures)

When you work out a multi-step procedure worth repeating — an API call chain, a report generator, a data transform — save it with `save_skill` (bash / python / node). Next time, `run_skill` replays it as a local script: instant, deterministic, zero token cost. Check `list_skills` before hand-deriving a procedure you may already have saved; update a skill by saving to the same name; pass `args` to parameterize (they arrive as the script's argv). Scripts live in `workspace/skills/` and run with the workspace as cwd.

Skills are global across chats. Rule of thumb: if you'd otherwise re-explain the same steps to yourself next week, make it a skill. The more you save, the more capable you get.
