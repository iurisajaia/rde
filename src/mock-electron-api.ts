// Browser shim: calls the zero-dependency Node bridge (server.js) running on the RDE.
// All supervisor actions execute locally via supervisorctl — no SSH, no Electron.
// Stats, procs, log streaming, and supervisor status push are over WebSocket (/rde-api/ws).
// Control actions (start/stop/restart) remain HTTP POST.

import { send, on } from './hooks/useWebSocket';

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

// ─── Event listeners (internal pub/sub for components) ───────────────────────

const eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();

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

// ─── Wire WS → internal events ───────────────────────────────────────────────

on('logs:line',    (msg) => emitEvent('logs/line',    { streamId: msg.streamId, file: msg.file, line: msg.line }));
on('logs:stopped', (msg) => emitEvent('logs/stopped', { streamId: msg.streamId, reason: msg.reason, message: 'stream ended' }));
on('supervisor-status', (msg) => {
  if (msg.services) emitEvent('supervisor/statusResult', { services: msg.services });
});
on('stats', (msg) => emitEvent('machine/stats', msg));
on('procs', (msg) => emitEvent('supervisor/procs', msg));

// ─── API ─────────────────────────────────────────────────────────────────────

const webAPI = {
  getConnectionStatus: async () => ({ connected: true, target: 'local', pid: null }),
  connect:    async () => ({ success: true }),
  disconnect: async () => ({ success: true }),

  supervisorStatus: (_target: string) => {
    // One-shot fetch over WS; falls back to HTTP if WS not ready
    return new Promise<any>((resolve) => {
      const off = on('supervisor-status', (msg) => {
        off();
        resolve({ success: true, services: msg.services });
      });
      send({ type: 'supervisor:status' });
      // Fallback: if no WS response within 3s, use HTTP
      setTimeout(() => {
        off();
        get('/supervisor/status').then(resolve);
      }, 3000);
    });
  },

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
    const streamId = `ws-${mode}-${Date.now()}`;

    if (mode === 'last') {
      send({ type: 'logs:tail', id: streamId, files, lines: n });
    } else {
      send({ type: 'logs:follow', id: streamId, files, lines: n });
    }

    return { success: true, streamId };
  },

  logsStop: async (streamId: string) => {
    send({ type: 'logs:stop', streamId });
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

  // Stats and procs are now WS-pushed; these subscribe and return a sentinel
  // so that components using the WS hook don't need to poll.
  machineStats: () => {
    send({ type: 'subscribe:stats' });
    return Promise.resolve({ success: true, _wsSubscribed: true });
  },

  supervisorProcs: () => {
    send({ type: 'subscribe:procs' });
    return Promise.resolve({ success: true, _wsSubscribed: true });
  },

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

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  (window as any).electronAPI = webAPI;
}
