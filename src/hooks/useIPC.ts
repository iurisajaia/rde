import { useCallback } from 'react';
import type { Service, LogLine, CommandOutput } from '../types';

export function useIPC() {
  const getSupervisorStatus = useCallback(async (target: string) => {
    return window.electronAPI.supervisorStatus(target);
  }, []);

  const restartService = useCallback(async (target: string, serviceName: string) => {
    return window.electronAPI.supervisorRestart(target, serviceName);
  }, []);

  const startService = useCallback(async (target: string, serviceName: string) => {
    return window.electronAPI.supervisorStart(target, serviceName);
  }, []);

  const stopService = useCallback(async (target: string, serviceName: string) => {
    return window.electronAPI.supervisorStop(target, serviceName);
  }, []);

  const bulkServiceOperation = useCallback(async (target: string, serviceNames: string[], operation: 'start' | 'stop' | 'restart') => {
    return window.electronAPI.supervisorBulk(target, serviceNames, operation);
  }, []);

  const listLogFiles = useCallback(async (target: string) => {
    return window.electronAPI.logsList(target);
  }, []);

  const tailLogs = useCallback(async (target: string, files: string[], mode: 'last' | 'follow', lines?: number) => {
    return window.electronAPI.logsTail(target, files, mode, lines);
  }, []);

  const stopLogStream = useCallback(async (streamId: string) => {
    return window.electronAPI.logsStop(streamId);
  }, []);

  const executeCommand = useCallback(async (target: string, command: string) => {
    return window.electronAPI.executeCommand(target, command);
  }, []);

  const getGitInfo = useCallback(async (target: string) => {
    const api = window.electronAPI.gitInfo;
    if (!api) return { success: false, error: 'Git is not available in this build' };
    return api(target);
  }, []);

  const getGitDiff = useCallback(async (target: string, file: string) => {
    const api = window.electronAPI.gitDiff;
    if (!api) return { success: false, error: 'Git is not available in this build' };
    return api(target, file);
  }, []);

  const onRdeStatus = useCallback((callback: (data: { state: string; message?: string }) => void) => {
    if (!window.electronAPI) return;
    return window.electronAPI.onRdeStatus(callback);
  }, []);

  const onSupervisorStatusResult = useCallback((callback: (data: { services: Service[] }) => void) => {
    if (!window.electronAPI) return;
    return window.electronAPI.onSupervisorStatusResult(callback);
  }, []);

  const onCommandOutput = useCallback((callback: (data: CommandOutput) => void) => {
    if (!window.electronAPI) return;
    return window.electronAPI.onCommandOutput((data: any) => callback({ ...data, timestamp: Date.now() }));
  }, []);

  const onLogsLine = useCallback((callback: (data: LogLine) => void) => {
    if (!window.electronAPI) return;
    return window.electronAPI.onLogsLine((data: any) => callback({ ...data, timestamp: Date.now() }));
  }, []);

  const onLogsStopped = useCallback((callback: (data: { streamId: string; reason: string; message?: string }) => void) => {
    if (!window.electronAPI) return;
    return window.electronAPI.onLogsStopped(callback);
  }, []);

  return {
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
