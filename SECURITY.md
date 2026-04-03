# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Talon, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/dylanneve1/talon/security/advisories/new) to submit your report. This ensures the issue can be assessed and fixed before public disclosure.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Fix or mitigation for confirmed vulnerabilities as soon as practical

## Scope

Talon is an AI agent with tool access (file system, web, messaging). Security issues of particular interest include:

- Prompt injection leading to unauthorized tool use
- Credential or token exposure in logs or responses
- Unauthorized access to the HTTP gateway
- Path traversal in file operations
- Dependency vulnerabilities with known exploits
