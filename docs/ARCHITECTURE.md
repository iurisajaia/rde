# Architecture

## Repository layout

- `src/` — React renderer. Browser builds use `mock-electron-api.ts` (demo data only; no HTTP backend).
- `docs/` — Product and contract notes (this file, MVP, IPC, etc.).
- `deployment/rde/` — nginx example and legacy supervisor stub (static UI only).

## High-level
- Single-page React app rendered from static assets.
- Runtime behavior comes from browser-side mock API (`window.electronAPI`) backed by demo fixtures.
- No shell command execution or filesystem access is performed by the app.

## Process model
- No external process orchestration in this repo.
- Actions mutate in-memory demo state only.

## Communication
- Event API is in-memory and browser-local.
- Streaming views simulate line-based output for UI testing.
