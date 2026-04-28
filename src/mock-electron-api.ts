/**
 * Browser-only shim: implements `window.electronAPI` with local demo data.
 * No HTTP backend — pure UI preview.
 */
import {
  DEMO_SERVICES,
  DEMO_LOG_FILES,
  DEMO_VENVS,
  DEMO_DOCKER_CONTAINERS,
  type DemoDockerContainer,
} from './demo-fixtures';
import type { Service } from './types';

const eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();

function emitEvent(channel: string, data: unknown) {
  eventListeners.get(channel)?.forEach((cb) => cb(data));
}

let services: Service[] = DEMO_SERVICES.map((s) => ({ ...s }));
let dockerState: DemoDockerContainer[] = DEMO_DOCKER_CONTAINERS.map((c) => ({ ...c }));

function emitSupervisorPush() {
  emitEvent('supervisor/statusResult', { services: [...services] });
}

const webAPI = {
  getConnectionStatus: async () => ({ connected: true, target: 'demo', pid: null }),

  connect: async () => ({ success: true }),

  disconnect: async () => ({ success: true }),

  supervisorStatus: async (_target: string) => ({
    success: true,
    services: [...services],
  }),

  supervisorRestart: async (_target: string, serviceName: string) => {
    services = services.map((s) =>
      s.name === serviceName ? { ...s, state: 'RUNNING', extra: 'restarted (demo)' } : s
    );
    emitSupervisorPush();
    return { success: true, serviceName, newState: 'RUNNING', output: 'restart (demo)' };
  },

  supervisorStart: async (_target: string, serviceName: string) => {
    services = services.map((s) =>
      s.name === serviceName ? { ...s, state: 'RUNNING', extra: 'started (demo)' } : s
    );
    emitSupervisorPush();
    return { success: true, serviceName, newState: 'RUNNING', output: 'start (demo)' };
  },

  supervisorStop: async (_target: string, serviceName: string) => {
    services = services.map((s) =>
      s.name === serviceName ? { ...s, state: 'STOPPED', extra: '' } : s
    );
    emitSupervisorPush();
    return { success: true, serviceName, newState: 'STOPPED', output: 'stop (demo)' };
  },

  supervisorBulk: async (
    _target: string,
    serviceNames: string[],
    operation: 'start' | 'stop' | 'restart'
  ) => {
    const results: Array<{ serviceName: string; success: boolean; newState?: string }> = [];
    for (const serviceName of serviceNames) {
      if (operation === 'stop') {
        services = services.map((s) =>
          s.name === serviceName ? { ...s, state: 'STOPPED', extra: '' } : s
        );
        results.push({ serviceName, success: true, newState: 'STOPPED' });
      } else {
        services = services.map((s) =>
          s.name === serviceName ? { ...s, state: 'RUNNING', extra: `${operation} (demo)` } : s
        );
        results.push({ serviceName, success: true, newState: 'RUNNING' });
      }
    }
    emitSupervisorPush();
    return { success: true, results };
  },

  logsList: async (_target: string) => ({
    success: true,
    files: [...DEMO_LOG_FILES],
  }),

  logsTail: async (_target: string, files: string[], mode: 'last' | 'follow', lines?: number) => {
    const streamId = `demo-${Date.now()}`;
    const maxLines = Math.min(lines ?? 20, 50);
    const pick = files[0] ?? DEMO_LOG_FILES[0];

    const emitLines = () => {
      for (let i = 0; i < maxLines; i++) {
        emitEvent('logs/line', {
          streamId,
          file: pick,
          line: `[demo ${mode}] line ${i + 1} — ${new Date().toISOString()}`,
        });
      }
      emitEvent('logs/stopped', { streamId, reason: 'complete', message: 'demo stream finished' });
    };

    if (mode === 'follow') {
      let n = 0;
      const tick = () => {
        if (n >= maxLines) {
          emitEvent('logs/stopped', { streamId, reason: 'complete', message: 'demo follow ended' });
          return;
        }
        emitEvent('logs/line', {
          streamId,
          file: pick,
          line: `[demo follow] ${++n} — ${new Date().toISOString()}`,
        });
        setTimeout(tick, 400);
      };
      setTimeout(tick, 100);
    } else {
      setTimeout(emitLines, 50);
    }

    return { success: true, streamId };
  },

  logsStop: async (_streamId: string) => ({ success: true }),

  executeCommand: async (_target: string, command: string) => {
    const commandId = `cmd-demo-${Date.now()}`;
    setTimeout(() => {
      emitEvent('command/output', {
        id: commandId,
        source: 'stdout',
        text: `[demo] $ ${command}\n(exit 0 — no shell attached)\n`,
      });
    }, 30);
    return { success: true, exitCode: 0, output: '', commandId };
  },

  supervisorVenvs: async () => ({ success: true, venvs: { ...DEMO_VENVS } }),

  gitInfo: async (_target: string) => ({
    success: true,
    branch: 'demo/ui-only',
    hasChanges: true,
    changes: [
      { status: 'M', file: 'src/App.tsx' },
      { status: '??', file: 'src/demo-fixtures.ts' },
    ],
  }),

  gitDiff: async (_target: string, file: string) => ({
    success: true,
    file,
    diff: `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,3 @@\n+demo diff — no git backend\n+…\n`,
  }),

  dockerContainers: async () => ({
    success: true,
    containers: dockerState.map((c) => ({ ...c })),
  }),

  dockerAction: async (containerId: string, action: 'start' | 'stop' | 'restart') => {
    dockerState = dockerState.map((c) => {
      if (c.id !== containerId) return c;
      if (action === 'stop') return { ...c, state: 'exited', status: 'Exited (demo)' };
      return { ...c, state: 'running', status: 'Up (demo)' };
    });
    return { success: true, output: `docker ${action} ${containerId} (demo)` };
  },

  onRdeStatus: (callback: (data: { state: string; message?: string }) => void) => {
    if (!eventListeners.has('rde/status')) eventListeners.set('rde/status', new Set());
    eventListeners.get('rde/status')!.add(callback as (data: unknown) => void);
    return () => eventListeners.get('rde/status')?.delete(callback as (data: unknown) => void);
  },

  onSupervisorStatusResult: (callback: (data: { services: Service[] }) => void) => {
    if (!eventListeners.has('supervisor/statusResult')) eventListeners.set('supervisor/statusResult', new Set());
    eventListeners.get('supervisor/statusResult')!.add(callback as (data: unknown) => void);
    return () => eventListeners.get('supervisor/statusResult')?.delete(callback as (data: unknown) => void);
  },

  onCommandOutput: (
    callback: (data: { id: string; source: 'stdout' | 'stderr'; text: string }) => void
  ) => {
    if (!eventListeners.has('command/output')) eventListeners.set('command/output', new Set());
    eventListeners.get('command/output')!.add(callback as (data: unknown) => void);
    return () => eventListeners.get('command/output')?.delete(callback as (data: unknown) => void);
  },

  onLogsLine: (
    callback: (data: { streamId: string; file: string; line: string }) => void
  ) => {
    if (!eventListeners.has('logs/line')) eventListeners.set('logs/line', new Set());
    eventListeners.get('logs/line')!.add(callback as (data: unknown) => void);
    return () => eventListeners.get('logs/line')?.delete(callback as (data: unknown) => void);
  },

  onLogsStopped: (
    callback: (data: { streamId: string; reason: string; message?: string }) => void
  ) => {
    if (!eventListeners.has('logs/stopped')) eventListeners.set('logs/stopped', new Set());
    eventListeners.get('logs/stopped')!.add(callback as (data: unknown) => void);
    return () => eventListeners.get('logs/stopped')?.delete(callback as (data: unknown) => void);
  },

  removeAllListeners: (channel: string) => {
    eventListeners.delete(channel);
  },
};

if (typeof window !== 'undefined' && !window.electronAPI) {
  (window as unknown as { electronAPI: typeof webAPI }).electronAPI = webAPI;
}
