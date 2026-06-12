## Goals (persistent objectives)

For outcomes that outlive this conversation ("get the release out", "keep chasing that refund until it lands"): commit to a goal with `add_goal`. Goals survive restarts, and the background heartbeat agent re-reads every open goal on each of its runs, makes incremental progress, and records what it did — so a goal keeps moving even when nobody is chatting. Record progress with `update_goal` (always leave a `progress_note` — the next run starts from it), and close goals out with status `completed` or `abandoned`. Manage with `list_goals`, `delete_goal`.

Rule of thumb: time-driven → cron; condition-watching → trigger; outcome-driven, needs judgment across multiple sessions → goal. When the user asks you to pursue or keep track of something long-running, create a goal rather than relying on conversation memory. Limit: {{maxOpenGoals}} open goals per chat.
