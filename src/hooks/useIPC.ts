import { useCallback } from 'react';
import type { ConnectionState, Service, LogLine, CommandOutput } from '../types';

export function useIPC() {
  const getConnectionStatus = useCallback(async () => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    if (typeof window.electronAPI.getConnectionStatus === 'function') {
      return window.electronAPI.getConnectionStatus();
    }
    return { connected: false, target: '', pid: null };
  }, []);

  const connect = useCallback(async (target: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.connect(target);
  }, []);

  const disconnect = useCallback(async () => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.disconnect();
  }, []);

  const getSupervisorStatus = useCallback(async (target: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.supervisorStatus(target);
  }, []);

  const restartService = useCallback(async (target: string, serviceName: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.supervisorRestart(target, serviceName);
  }, []);

  const startService = useCallback(async (target: string, serviceName: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.supervisorStart(target, serviceName);
  }, []);

  const stopService = useCallback(async (target: string, serviceName: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.supervisorStop(target, serviceName);
  }, []);

  const bulkServiceOperation = useCallback(async (target: string, serviceNames: string[], operation: 'start' | 'stop' | 'restart') => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.supervisorBulk(target, serviceNames, operation);
  }, []);

  const listLogFiles = useCallback(async (target: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.logsList(target);
  }, []);

  const tailLogs = useCallback(async (
    target: string,
    files: string[],
    mode: 'last' | 'follow',
    lines?: number
  ) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.logsTail(target, files, mode, lines);
  }, []);

  const stopLogStream = useCallback(async (streamId: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.logsStop(streamId);
  }, []);

  const executeCommand = useCallback(async (target: string, command: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.executeCommand(target, command);
  }, []);

  const getGitInfo = useCallback(async (target: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.gitInfo(target);
  }, []);

  const getGitDiff = useCallback(async (target: string, file: string) => {
    if (!window.electronAPI) {
      throw new Error('API not available');
    }
    return window.electronAPI.gitDiff(target, file);
  }, []);

  const onRdeStatus = useCallback((callback: (data: { state: ConnectionState; message?: string }) => void) => {
    if (!window.electronAPI) return;
    window.electronAPI.onRdeStatus((data) => {
      callback({
        state: data.state as ConnectionState,
        message: data.message
      });
    });
    return () => {
      window.electronAPI.removeAllListeners('rde/status');
    };
  }, []);

  const onSupervisorStatusResult = useCallback((callback: (data: { services: Service[] }) => void) => {
    if (!window.electronAPI) return;
    window.electronAPI.onSupervisorStatusResult(callback);
    return () => {
      window.electronAPI.removeAllListeners('supervisor/statusResult');
    };
  }, []);

  const onCommandOutput = useCallback((callback: (data: CommandOutput) => void) => {
    if (!window.electronAPI) return;
    window.electronAPI.onCommandOutput((data) => {
      callback({
        ...data,
        timestamp: Date.now()
      });
    });
    return () => {
      window.electronAPI.removeAllListeners('command/output');
    };
  }, []);

  const onLogsLine = useCallback((callback: (data: LogLine) => void) => {
    if (!window.electronAPI) return;
    window.electronAPI.onLogsLine((data) => {
      callback({
        ...data,
        timestamp: Date.now()
      });
    });
    return () => {
      window.electronAPI.removeAllListeners('logs/line');
    };
  }, []);

  const onLogsStopped = useCallback((callback: (data: { streamId: string; reason: string; message?: string }) => void) => {
    if (!window.electronAPI) return;
    window.electronAPI.onLogsStopped(callback);
    return () => {
      window.electronAPI.removeAllListeners('logs/stopped');
    };
  }, []);

  return {
    getConnectionStatus,
    connect,
    disconnect,
    getSupervisorStatus,
    restartService,
    startService,
    stopService,
    bulkServiceOperation,
    listLogFiles,
    tailLogs,
    stopLogStream,
    executeCommand,
    getGitInfo,
    getGitDiff,
    onRdeStatus,
    onSupervisorStatusResult,
    onCommandOutput,
    onLogsLine,
    onLogsStopped,
  };
}

