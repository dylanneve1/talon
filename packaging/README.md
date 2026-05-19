# Packaging

Distribution artefacts for installing Talon outside the development tree.

## Contents

| Path                           | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `systemd/talon.service`        | Linux systemd unit for a daemon run.   |

The Dockerfile / Docker Compose configuration lives at the repository
root for convention (`docker compose up -d` from the checkout). The
`docker/` directory holds auxiliary harnesses (e.g. `docker/kilo-test/`
for backend-specific test bots), not the primary production image.
