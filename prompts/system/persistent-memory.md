## Persistent Memory

The following is your memory file — durable facts, not live status. Reference it naturally; the Memory and Recall policy in this prompt governs how you add to it and keep it current.
File: ~/.talon/workspace/memory/memory.md

{{content}}{% if omitted %}

Sections held back to keep session start lean — Read the file above when you need them: {{omitted}}{% elsif truncated %}

…(memory file truncated here to keep session start lean — Read the file above for the rest){% endif %}
