// Web API — talks to the Express server running on the RDE itself.
// All commands execute locally on the RDE; no SSH session needed.

// Same-origin API prefix: nginx maps /rde-api/ → Express /api/ (Swagger: /rde-api/docs).
const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL)
  ? import.meta.env.VITE_API_BASE_URL
  : '/rde-api';

// Event listeners for WebSocket channels
const eventListeners: Map<string, Set<Function>> = new Map();

function emitEvent(channel: string, data: any) {
  eventListeners.get(channel)?.forEach(cb => cb(data));
}

// WebSocket for real-time streaming (logs, command output, status)
let ws: WebSocket | null = null;
let wsReconnectTimeout: ReturnType<typeof setTimeout> | null = null;

function connectWebSocket() {
  let wsUrl: string;
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WS_URL) {
    wsUrl = import.meta.env.VITE_WS_URL;
  } else if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${proto}//${window.location.host}/rde-api/ws`;
  } else {
    wsUrl = 'ws://localhost:20000/api/ws';
  }

  console.log('[WS] Connecting to:', wsUrl);
  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Connected');
      if (wsReconnectTimeout) { clearTimeout(wsReconnectTimeout); wsReconnectTimeout = null; }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        emitEvent(message.channel, message.data);
      } catch (e) {
        console.error('[WS] Failed to parse message:', e);
      }
    };

    ws.onerror = () => {};

    ws.onclose = (event) => {
      ws = null;
      if (event.code !== 1000) {
        wsReconnectTimeout = setTimeout(connectWebSocket, 3000);
      }
    };
  } catch (error) {
    console.warn('[WS] Connection error:', error);
  }
}

if (typeof window !== 'undefined') {
  connectWebSocket();
}

const webAPI = {
  // Always connected — the server IS the RDE
  getConnectionStatus: async () => ({ connected: true, target: 'local', pid: null }),

  connect: async () => ({ success: true }),

  disconnect: async () => ({ success: true }),

  supervisorStatus: async (_target: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/supervisor/status`);
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  supervisorRestart: async (_target: string, serviceName: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/supervisor/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  supervisorStart: async (_target: string, serviceName: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/supervisor/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  supervisorStop: async (_target: string, serviceName: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/supervisor/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  supervisorBulk: async (_target: string, serviceNames: string[], operation: 'start' | 'stop' | 'restart') => {
    try {
      const res = await fetch(`${API_BASE_URL}/supervisor/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceNames, operation })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  logsList: async (_target: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/logs/list`);
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  logsTail: async (_target: string, files: string[], mode: 'last' | 'follow', lines?: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/logs/tail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, mode, lines })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  logsStop: async (streamId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/logs/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  executeCommand: async (_target: string, command: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/command/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  supervisorVenvs: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/supervisor/venvs`);
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  gitInfo: async (_target: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/git/info`);
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  gitDiff: async (_target: string, file: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/git/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  // Event subscriptions (backed by WebSocket)
  onRdeStatus: (callback: (data: { state: string; message?: string }) => void) => {
    if (!eventListeners.has('rde/status')) eventListeners.set('rde/status', new Set());
    eventListeners.get('rde/status')!.add(callback);
    return () => eventListeners.get('rde/status')?.delete(callback);
  },

  onSupervisorStatusResult: (callback: (data: { services: any[] }) => void) => {
    if (!eventListeners.has('supervisor/statusResult')) eventListeners.set('supervisor/statusResult', new Set());
    eventListeners.get('supervisor/statusResult')!.add(callback);
    return () => eventListeners.get('supervisor/statusResult')?.delete(callback);
  },

  onCommandOutput: (callback: (data: { id: string; source: 'stdout' | 'stderr'; text: string }) => void) => {
    if (!eventListeners.has('command/output')) eventListeners.set('command/output', new Set());
    eventListeners.get('command/output')!.add(callback);
    return () => eventListeners.get('command/output')?.delete(callback);
  },

  onLogsLine: (callback: (data: { streamId: string; file: string; line: string }) => void) => {
    if (!eventListeners.has('logs/line')) eventListeners.set('logs/line', new Set());
    eventListeners.get('logs/line')!.add(callback);
    return () => eventListeners.get('logs/line')?.delete(callback);
  },

  onLogsStopped: (callback: (data: { streamId: string; reason: string; message?: string }) => void) => {
    if (!eventListeners.has('logs/stopped')) eventListeners.set('logs/stopped', new Set());
    eventListeners.get('logs/stopped')!.add(callback);
    return () => eventListeners.get('logs/stopped')?.delete(callback);
  },

  removeAllListeners: (channel: string) => { eventListeners.delete(channel); }
};

if (typeof window !== 'undefined' && !window.electronAPI) {
  (window as any).electronAPI = webAPI;
}
