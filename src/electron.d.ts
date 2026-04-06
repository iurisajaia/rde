export interface ElectronAPI {
  // Renderer → Main (handlers)
  connect: (target: string) => Promise<{ success: boolean; error?: string }>;
  disconnect: () => Promise<{ success: boolean; error?: string }>;
  supervisorStatus: (target: string) => Promise<{ success: boolean; services?: any[]; error?: string }>;
  supervisorRestart: (target: string, serviceName: string) => Promise<{ success: boolean; serviceName?: string; newState?: string; output?: string; error?: string }>;
  supervisorStart: (target: string, serviceName: string) => Promise<{ success: boolean; serviceName?: string; newState?: string; output?: string; error?: string }>;
  supervisorStop: (target: string, serviceName: string) => Promise<{ success: boolean; serviceName?: string; newState?: string; output?: string; error?: string }>;
  supervisorBulk: (target: string, serviceNames: string[], operation: 'start' | 'stop' | 'restart') => Promise<{ success: boolean; results?: Array<{ serviceName: string; success: boolean; newState?: string; output?: string; error?: string }>; error?: string }>;
  logsList: (target: string) => Promise<{ success: boolean; files?: string[]; error?: string }>;
  logsTail: (target: string, files: string[], mode: 'last' | 'follow', lines?: number) => Promise<{ success: boolean; streamId?: string; error?: string }>;
  logsStop: (streamId: string) => Promise<{ success: boolean; error?: string }>;
  executeCommand: (target: string, command: string) => Promise<{ success: boolean; exitCode?: number; output?: string; error?: string; commandId?: string }>;
  /** Web mock + future Electron IPC; absent in current preload.js */
  gitInfo?: (target: string) => Promise<{
    success: boolean;
    branch?: string;
    changes?: Array<{ status: string; file: string }>;
    hasChanges?: boolean;
    error?: string;
  }>;
  gitDiff?: (target: string, file: string) => Promise<{ success: boolean; diff?: string; file?: string; error?: string }>;
  supervisorVenvs?: () => Promise<{ success: boolean; venvs?: Record<string, string>; error?: string }>;

  // Main → Renderer (events)
  onRdeStatus: (callback: (data: { state: string; message?: string }) => void) => void;
  onSupervisorStatusResult: (callback: (data: { services: any[] }) => void) => void;
  onCommandOutput: (callback: (data: { id: string; source: 'stdout' | 'stderr'; text: string }) => void) => void;
  onLogsLine: (callback: (data: { streamId: string; file: string; line: string }) => void) => void;
  onLogsStopped: (callback: (data: { streamId: string; reason: string; message?: string }) => void) => void;

  // Remove listeners
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

