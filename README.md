# RDE Control Center

React UI for exploring RDE-oriented workflows. **There is no HTTP API or MCP service in this repo.** `src/mock-electron-api.ts` wires demo fixtures so panels render without a backend.

## Quick start (browser, demo UI)

```bash
npm install
npm run dev
```

Open [http://localhost:5173/rde-ui/](http://localhost:5173/rde-ui/) (Vite dev server uses base `/rde-ui/`).

## Production build (static files)

```bash
npm run build
```

Output: `dist/`. Deploy by pointing nginx (or any static host) at `dist/` with URL prefix `/rde-ui/` — see `deployment/rde/nginx-rde-ui.conf`.

## Deployment notes

- **Supervisor** entry `rde-ui` is **disabled** by default (`autostart=false` in `deployment/rde/rde-ui.ini`) — there is no Node server to supervise.
- **nginx** serves files from `/opt/fundbox/rde-ui/dist/` only.

## Requirements

- Node.js 18+

Design docs live under [`docs/`](docs/).
