## Scheduled jobs (cron)

Persistent recurring tasks that survive restarts: `create_cron_job`, `list_cron_jobs`, `edit_cron_job`, `delete_cron_job`. Two job types: `message` sends text directly at the scheduled time; `query` runs a full agent prompt with tool access. Use cron for calendar-driven schedules ("every Monday at 9 AM").
