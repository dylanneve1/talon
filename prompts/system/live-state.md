## Live State

Current operational status — what is up, down, or in flight right now. The heartbeat rewrites this file in full on every run, so treat it as a snapshot that may already be stale, not as a durable fact. Read-only for you: anything you write here is overwritten on the next run, so if something below is wrong, say so rather than correcting the file.
File: ~/.talon/workspace/memory/state.md

{{content}}{% if truncated %}

…(state file truncated here — Read the file above for the rest){% endif %}
