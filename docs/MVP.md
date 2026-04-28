# RDE Control Center — MVP (Electron + React)

## Goal
A very small Mac-only desktop app that replaces “many terminals” for common RDE tasks:
1) Connect to RDE using `rde ssh`
2) View logs (all logs from `/opt/fundbox/logs/*.log`)
3) Restart services via `sudo supervisorctl restart <service>`
4) Check service status via `sudo supervisorctl status`

No extra features (auth, sharing, config parsing, dashboards) in MVP.

---

## Non-goals (MVP)
- No Rust/Tauri
- No direct SSH (must use `rde ssh` CLI only)
- No per-service log discovery beyond “all logs”
- No fancy persistence, no multi-profile
- No team distribution / signing / notarization

---

## Assumptions
- `rde` CLI is installed on the Mac and works from a normal shell
- User can run `rde ssh <target>` successfully
- `sudo supervisorctl ...` works inside RDE (may prompt for password; MVP may fail gracefully if it prompts)
- Logs exist in `/opt/fundbox/logs/` (glob `*.log`)

---

## UX (MVP)

### Screen layout (single window)
- Top bar:
  - RDE Target input (text): e.g. `my-rde-env` (whatever your real target string is)
  - Buttons: **Connect**, **Disconnect**
  - Connection status indicator: Disconnected / Connecting / Connected / Error

- Left panel: **Services**
  - Button: **Refresh Status**
  - Search input (client-side filter)
  - Table/list:
    - Name (full supervisor name like `backend-group:audit_log`)
    - State (RUNNING/STOPPED/FATAL/etc)
    - Extra (pid/uptime/message if parseable)
  - Row actions:
    - **Restart** (runs `sudo supervisorctl restart <name>`)

- Right panel: **Logs**
  - Button: **Load log file list**
  - Multi-select list of log files found in `/opt/fundbox/logs/*.log`
  - Buttons:
    - **Open (last 200 lines)**
    - **Follow** (live stream)
    - **Stop Follow** (kills stream)
    - **Clear output**
  - Output viewer:
    - Shows lines with file prefix (e.g. `[application.log] <line>`)
    - Search box that filters currently loaded output (frontend only)

### Minimal flows
1) User enters target, clicks Connect.
2) User clicks Refresh Status, sees services.
3) User clicks Restart on a service, sees command output.
4) User loads log list, selects a few files, follows them.

---

## Technical approach

### App structure
- Electron Main (Node):
  - Owns all `child_process.spawn()` calls
  - Maintains “connection state” (logical state only; MVP does NOT keep a single interactive SSH session)
  - Runs commands by spawning `rde ssh <target> -- <command>` OR `rde ssh <target> "<command>"`
    - Choose the exact invocation that works in your environment and keep it consistent.

- React Renderer:
  - UI
  - Sends IPC requests to Main
  - Receives streamed output/events from Main
  - Keeps in-memory state only (services list, log buffers, command outputs)

### Why “no persistent SSH session” in MVP?
Simplest + safest:
- Each action spawns a fresh `rde ssh ...` process.
- Log follow spawns one long-lived process per “Follow” session.
This avoids output interleaving and reduces debugging.

---

## Commands (MVP)

### 1) Supervisor status
- Remote command:
  - `sudo supervisorctl status`
- Parsing:
  - Parse each line into:
    - `name` = first token
    - `state` = second token (RUNNING/STOPPED/etc)
    - `extra` = rest of line (pid/uptime/message)
  - Store as array of `Service` objects.

### 2) Restart service
- Remote command:
  - `sudo supervisorctl restart <serviceName>`
- Capture stdout/stderr and show in output panel (or toast + output tab).

### 3) List log files
- Remote command:
  - `ls -1 /opt/fundbox/logs/*.log 2>/dev/null || true`
- Parse lines as file paths; show base name in UI.

### 4) Open last N lines
- Remote command (per selected file):
  - `tail -n 200 <file>`
- Renderer prefixes each line with `[<basename>]`

### 5) Follow logs (stream)
- Remote command (per selected file):
  - `tail -F <file>`
- Stream stdout line-by-line via IPC
- Stop Follow = kill the spawned process(es)

---

## IPC contract (Renderer <-> Main)

### Renderer -> Main
- `rde/connect` { target: string }
  - MVP behavior: just validates we can run a cheap remote command (e.g. `echo ok`)
- `rde/disconnect` {}
  - MVP: stops any running log streams and marks state as disconnected
- `supervisor/status` { target: string }
- `supervisor/restart` { target: string, serviceName: string }
- `logs/list` { target: string }
- `logs/tail` { target: string, files: string[], mode: "last"|"follow", lines?: number }
  - returns `streamId`
- `logs/stop` { streamId: string }

### Main -> Renderer (events)
- `rde/status` { state: "disconnected"|"connecting"|"connected"|"error", message?: string }
- `supervisor/statusResult` { services: Service[] }
- `command/output` { id: string, source: "stdout"|"stderr", text: string }
- `logs/line` { streamId: string, file: string, line: string }
- `logs/stopped` { streamId: string, reason: "user"|"exit"|"error", message?: string }

---

## Data types (MVP)
```ts
type Service = {
  name: string;      // backend-group:audit_log
  state: string;     // RUNNING / STOPPED / FATAL ...
  extra: string;     // rest of the line
};

type LogFile = {
  path: string;      // /opt/fundbox/logs/application.log
  name: string;      // application.log
};
