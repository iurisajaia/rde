# RDE Control Center

A web-based control center for managing RDE (Remote Development Environment) services, logs, and commands.

## Quick Start (Web App)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the backend server and frontend:**
   ```bash
   npm run dev:browser
   ```

   This will start **BOTH**:
   - Backend API server on `http://localhost:3000` (required!)
   - Frontend dev server on `http://localhost:5173`

   **Important:** You need BOTH servers running! The frontend (5173) connects to the backend (3000).

3. **Open your browser:**
   ```
   http://localhost:5173
   ```

   **Troubleshooting:**
   - If you see WebSocket connection errors, make sure the backend server is running on port 3000
   - Check the terminal output - you should see both servers starting
   - Backend should show: `🚀 RDE Control Center API server running on http://localhost:3000`
   - Frontend should show: `Local: http://localhost:5173`

## Development

### Web Mode (Recommended)
```bash
npm run dev:browser
```

### Electron Mode (Legacy)
```bash
npm run dev
```

### Build for Production
```bash
npm run build
```

The built files will be in the `dist/` directory.

## Configuration

The app uses environment variables for configuration. Create a `.env` file:

```env
# API Configuration
VITE_API_BASE_URL=http://localhost:3000/api
VITE_WS_URL=ws://localhost:3000/api/ws

# Server Port (for server.js)
PORT=3000
```

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Backend**: Express.js server (`server.js`) that wraps RDE commands
- **Real-time**: WebSocket for live updates

## Features

- Connect/disconnect to RDE
- View and manage supervisor services
- Tail and view log files
- Execute custom commands
- SDK update workflow
- Dark/light theme support

## Requirements

- Node.js 18+
- `rde` command available in PATH or common locations
