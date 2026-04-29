// Browser shim: calls the zero-dependency Node bridge (server.js) running on the RDE.
// All supervisor actions execute locally via supervisorctl — no SSH, no Electron.

const BASE = '/rde-api';

async function post(path: string, body: object) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

async function get(path: string) {
  try {
    const res = await fetch(`${BASE}${path}`);
    return res.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

// Event listeners
const eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();

// Active SSE connections keyed by streamId (for logsStop)
const activeEventSources = new Map<string, EventSource>();

const webAPI = {
  getConnectionStatus: async () => ({ connected: true, target: 'local', pid: null }),
  connect:    async () => ({ success: true }),
  disconnect: async () => ({ success: true }),

  supervisorStatus: (_target: string) => get('/supervisor/status'),

  supervisorRestart: (_target: string, serviceName: string) =>
    post('/supervisor/restart', { serviceName, operation: 'restart' }),

  supervisorStart: (_target: string, serviceName: string) =>
    post('/supervisor/start', { serviceName, operation: 'start' }),

  supervisorStop: (_target: string, serviceName: string) =>
    post('/supervisor/stop', { serviceName, operation: 'stop' }),

  supervisorBulk: (_target: string, serviceNames: string[], operation: 'start' | 'stop' | 'restart') =>
    post('/supervisor/bulk', { serviceNames, operation }),

  logsList: (_target: string) => get('/logs/list'),

  logsTail: async (_target: string, files: string[], mode: 'last' | 'follow', lines?: number) => {
    const n = lines ?? 200;

    if (mode === 'last') {
      const r = await post('/logs/tail', { files, lines: n });
      if (!r.success) return r;
      const streamId = `snap-${Date.now()}`;
      const rawLines: string[] = (r.output || '').split('\n');
      // tail uses ==> /path/to/file <== headers when tailing multiple files
      setTimeout(() => {
        let currentFile = files[0];
        for (const line of rawLines) {
          const m = line.match(/^==> (.+) <==$/);
          if (m) { currentFile = m[1]; continue; }
          if (line) emitEvent('logs/line', { streamId, file: currentFile, line });
        }
        emitEvent('logs/stopped', { streamId, reason: 'complete', message: 'done' });
      }, 0);
      return { success: true, streamId };
    }

    // follow mode — use SSE so lines stream in real time
    const params = new URLSearchParams({
      files: files.map(f => encodeURIComponent(f)).join(','),
      lines: String(n),
    });
    const es = new EventSource(`${BASE}/logs/stream?${params}`);
    let streamId: string | null = null;

    es.addEventListener('streamId', (e: MessageEvent) => {
      streamId = JSON.parse(e.data).streamId;
      // Register so logsStop can close it
      if (streamId) activeEventSources.set(streamId, es);
    });

    es.addEventListener('line', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      emitEvent('logs/line', data);
    });

    es.addEventListener('stopped', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      emitEvent('logs/stopped', { ...data, message: 'stream ended' });
      es.close();
      if (streamId) activeEventSources.delete(streamId);
    });

    es.onerror = () => {
      if (streamId) {
        emitEvent('logs/stopped', { streamId, reason: 'error', message: 'connection lost' });
        activeEventSources.delete(streamId);
      }
      es.close();
    };

    // Return a temporary streamId immediately; the real one arrives via SSE
    const tempId = `sse-${Date.now()}`;
    return { success: true, streamId: tempId };
  },

  logsStop: async (streamId: string) => {
    const es = activeEventSources.get(streamId);
    if (es) { es.close(); activeEventSources.delete(streamId); }
    // Also tell server to kill the child process
    await post('/logs/stop', { streamId });
    return { success: true };
  },

  executeCommand: async (_target: string, command: string) => {
    const r = await post('/command/execute', { command });
    const commandId = `cmd-${Date.now()}`;
    if (r.output) {
      setTimeout(() => emitEvent('command/output', { id: commandId, source: 'stdout', text: r.output }), 0);
    }
    return { ...r, commandId };
  },

  supervisorVenvs: () => get('/supervisor/venvs'),

  gitInfo:  async (_target: string) => ({ success: false, error: 'Not available' }),
  gitDiff:  async (_target: string, _file: string) => ({ success: false, error: 'Not available' }),

  dockerContainers: () => get('/docker/containers'),
  dockerAction: (containerId: string, action: 'start' | 'stop' | 'restart') =>
    post('/docker/action', { containerId, action }),

  onRdeStatus: (callback: (data: { state: string; message?: string }) => void) => {
    addListener('rde/status', callback as (d: unknown) => void);
    return () => removeListener('rde/status', callback as (d: unknown) => void);
  },

  onSupervisorStatusResult: (callback: (data: { services: any[] }) => void) => {
    addListener('supervisor/statusResult', callback as (d: unknown) => void);
    return () => removeListener('supervisor/statusResult', callback as (d: unknown) => void);
  },

  onCommandOutput: (callback: (data: { id: string; source: 'stdout' | 'stderr'; text: string }) => void) => {
    addListener('command/output', callback as (d: unknown) => void);
    return () => removeListener('command/output', callback as (d: unknown) => void);
  },

  onLogsLine: (callback: (data: { streamId: string; file: string; line: string }) => void) => {
    addListener('logs/line', callback as (d: unknown) => void);
    return () => removeListener('logs/line', callback as (d: unknown) => void);
  },

  onLogsStopped: (callback: (data: { streamId: string; reason: string; message?: string }) => void) => {
    addListener('logs/stopped', callback as (d: unknown) => void);
    return () => removeListener('logs/stopped', callback as (d: unknown) => void);
  },

  removeAllListeners: (channel: string) => { eventListeners.delete(channel); },
};

function addListener(channel: string, cb: (d: unknown) => void) {
  if (!eventListeners.has(channel)) eventListeners.set(channel, new Set());
  eventListeners.get(channel)!.add(cb);
}

function removeListener(channel: string, cb: (d: unknown) => void) {
  eventListeners.get(channel)?.delete(cb);
}

function emitEvent(channel: string, data: unknown) {
  eventListeners.get(channel)?.forEach(cb => cb(data));
}

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  (window as any).electronAPI = webAPI;
}
