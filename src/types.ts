export type Service = {
  name: string;
  state: string;
  extra: string;
};

export type LogFile = {
  path: string;
  name: string;
};

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type LogStreamMode = 'last' | 'follow';

export interface LogLine {
  streamId: string;
  file: string;
  line: string;
  timestamp: number;
  lineNumber?: number;
}

export interface CommandOutput {
  id: string;
  source: 'stdout' | 'stderr';
  text: string;
  timestamp: number;
}

export type Theme = 'light' | 'dark';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

export interface LogBookmark {
  id: string;
  line: LogLine;
  note?: string;
  createdAt: number;
}

