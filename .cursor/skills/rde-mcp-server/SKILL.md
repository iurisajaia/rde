---
name: rde-mcp-server
description: >-
  Designs and implements an MCP server for the rde-ui repo that exposes RDE
  operations to AI clients. Covers supervisorctl service state, Docker containers,
  Fundbox service logs under /opt/fundbox/logs, system info and load, and safe
  command boundaries. Use when the user mentions MCP, Model Context Protocol,
  rde-ui MCP, supervisor status on RDE, remote logs, or wiring Cursor to the RDE host.
---

# RDE MCP server (rde-ui)

## Goal

Add an MCP server in this repo that lets agents **inspect** (and optionally **control**) the same machine the RDE UI `server.js` already targets: Ubuntu RDE with Fundbox layout.

Prefer **thin tools** with **structured JSON** responses. Reuse existing HTTP handlers or shared `runLocal`-style helpers where possible.

## Required tool surface (minimum)

| Area | Capabilities |
|------|----------------|
| **Supervisor** | List all programs with state (equivalent to `sudo supervisorctl status all`). Optionally start/stop/restart named services (match existing REST semantics and parsing in `server.js`). |
| **Docker** | List containers (`docker ps -a` style JSON). Optional start/stop/restart by id (align with `/api/docker/*`). |
| **Logs** | List known log files under `/opt/fundbox/logs/`; read last *N* lines of allowed paths only (no path traversal). Follow patterns in `server.js` `/api/logs/*`. |
| **System** | Hostname, uptime, load average, memory (`free -h` or `/proc`), disk (`df -h` on key mounts). Read-only. |

## Canonical paths and commands

- Service logs: `/opt/fundbox/logs/<service>.log` (see project rule `rde.mdc`).
- Supervisor: `sudo supervisorctl status|start|stop|restart <name>`.
- Repos on RDE: `/opt/fundbox/<repo_name>/`.

## Implementation notes

1. **Reuse before duplicating**: `server.js` already implements supervisor, logs, docker, and `runLocal`. Extract shared helpers into a small module both Express and the MCP process can `require`, or have MCP call localhost HTTP with a shared secret — pick one approach and stick to it.
2. **Security**: Default to **read-only** tools. Expose mutating operations (supervisor/docker actions) as **separate** tools; avoid a generic “run any shell” MCP tool unless strictly scoped and documented.
3. **Log safety**: Only serve files under `/opt/fundbox/logs/` (or an explicit allowlist). Reject `..`, symlinks escaping the tree, and absolute paths outside the allowlist.
4. **Streaming**: MCP often works better with “last N lines” than long `tail -f` streams; if follow-mode is needed, document limits and cancellation.
5. **Local dev**: MCP runs where the user configures it (often their Mac); this repo’s deployment mode runs `server.js` **on the RDE** (`0.0.0.0`). Ensure the MCP entrypoint is documented (stdio vs SSE) and matches how Cursor registers the server.

## Checklist before shipping

- [ ] Tool list covers supervisor, docker, logs (list + tail), system metrics.
- [ ] No unbounded arbitrary command execution from MCP unless explicitly required and gated.
- [ ] Responses are JSON-friendly (strings, numbers, arrays of objects).
- [ ] README or package script documents how to run the MCP server and required env (e.g. `PORT`, sudo/nopasswd for supervisor on RDE).

## Related project context

- RDE access and paths: `.cursor/rules/rde.mdc`
- Existing REST surface: `server.js` (`/api/supervisor/*`, `/api/logs/*`, `/api/docker/*`)
