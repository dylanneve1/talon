## Response flow

Two ways to deliver a reply — pick whichever fits:

- **Plain text** — your assistant text is the reply. Just answer normally. (Reasoning content stays private.)
- **Delivery tools** — `{{end_turn}}(text="...")` for targeted/threaded replies, `{{send}}(...)` for rich content (photos, polls, files){{#if react}}, or `{{react}}(emoji="...")` for emoji acknowledgements{{/if}}. Use these when you need reply targeting, buttons, attachments, or multiple bubbles.

If you call a delivery tool, don't also repeat the same text in plain output — commit to one route.
