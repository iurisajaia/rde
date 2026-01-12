// Web API implementation - uses HTTP instead of Electron IPC
// Set API_BASE_URL environment variable or use default

const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) 
  ? import.meta.env.VITE_API_BASE_URL 
  : 'http://localhost:3000/api';

// Event listeners storage for WebSocket/SSE simulation
const eventListeners: Map<string, Set<Function>> = new Map();

// Helper to emit events
function emitEvent(channel: string, data: any) {
  const listeners = eventListeners.get(channel);
  if (listeners) {
    listeners.forEach(callback => callback(data));
  }
}

// WebSocket connection for real-time events (optional)
let ws: WebSocket | null = null;
let wsReconnectTimeout: ReturnType<typeof setTimeout> | null = null;

function connectWebSocket() {
  const wsUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WS_URL)
    ? import.meta.env.VITE_WS_URL
    : API_BASE_URL.replace('http', 'ws').replace('/api', '') + '/api/ws';
  try {
    console.log('[WebSocket] Connecting to:', wsUrl);
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('[WebSocket] Connected successfully');
      if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        emitEvent(message.channel, message.data);
      } catch (e) {
        console.error('[WebSocket] Failed to parse message:', e, event.data);
      }
    };
    
    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
      // Don't log the full error object, just a message
      console.error('[WebSocket] Connection failed. Make sure server is running on port 3000');
    };
    
    ws.onclose = (event) => {
      console.log('[WebSocket] Disconnected. Code:', event.code, 'Reason:', event.reason);
      ws = null;
      // Only reconnect if it wasn't a manual close
      if (event.code !== 1000) {
        console.log('[WebSocket] Reconnecting in 3 seconds...');
        wsReconnectTimeout = setTimeout(connectWebSocket, 3000);
      }
    };
  } catch (error) {
    console.warn('[WebSocket] Connection error:', error);
  }
}

// Start WebSocket connection
if (typeof window !== 'undefined') {
  connectWebSocket();
}

const webAPI = {
  // Renderer → Main (handlers) - use HTTP API
  getConnectionStatus: async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/rde/status`);
      return await response.json();
    } catch (error) {
      return { connected: false, target: '', pid: null };
    }
  },
  
  connect: async (target: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/rde/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  disconnect: async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/rde/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  supervisorStatus: async (target: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/supervisor/status?target=${encodeURIComponent(target)}`);
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  supervisorRestart: async (target: string, serviceName: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/supervisor/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, serviceName })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  supervisorStart: async (target: string, serviceName: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/supervisor/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, serviceName })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  supervisorStop: async (target: string, serviceName: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/supervisor/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, serviceName })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  supervisorBulk: async (target: string, serviceNames: string[], operation: 'start' | 'stop' | 'restart') => {
    try {
      const response = await fetch(`${API_BASE_URL}/supervisor/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, serviceNames, operation })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  logsList: async (target: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/logs/list?target=${encodeURIComponent(target)}`);
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  logsTail: async (target: string, files: string[], mode: 'last' | 'follow', lines?: number) => {
    try {
      const response = await fetch(`${API_BASE_URL}/logs/tail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, files, mode, lines })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  logsStop: async (streamId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/logs/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },
  
  executeCommand: async (target: string, command: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/command/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, command })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },

  gitInfo: async (target: string) => {
    console.log('[mock-electron-api] gitInfo called with target:', target);
    console.log('[mock-electron-api] API_BASE_URL:', API_BASE_URL);
    const url = `${API_BASE_URL}/git/info?target=${encodeURIComponent(target)}`;
    console.log('[mock-electron-api] Fetching from URL:', url);
    try {
      const response = await fetch(url);
      console.log('[mock-electron-api] Response status:', response.status);
      const data = await response.json();
      console.log('[mock-electron-api] Response data:', data);
      return data;
    } catch (error) {
      console.error('[mock-electron-api] gitInfo error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },

  gitDiff: async (target: string, file: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/git/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, file })
      });
      return await response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },

  // Main → Renderer (events) - use event listeners
  onRdeStatus: (callback: (data: { state: string; message?: string }) => void) => {
    if (!eventListeners.has('rde/status')) {
      eventListeners.set('rde/status', new Set());
    }
    eventListeners.get('rde/status')!.add(callback);
    return () => {
      eventListeners.get('rde/status')?.delete(callback);
    };
  },
  
  onSupervisorStatusResult: (callback: (data: { services: any[] }) => void) => {
    if (!eventListeners.has('supervisor/statusResult')) {
      eventListeners.set('supervisor/statusResult', new Set());
    }
    eventListeners.get('supervisor/statusResult')!.add(callback);
    return () => {
      eventListeners.get('supervisor/statusResult')?.delete(callback);
    };
  },
  
  onCommandOutput: (callback: (data: { id: string; source: 'stdout' | 'stderr'; text: string }) => void) => {
    if (!eventListeners.has('command/output')) {
      eventListeners.set('command/output', new Set());
    }
    eventListeners.get('command/output')!.add(callback);
    return () => {
      eventListeners.get('command/output')?.delete(callback);
    };
  },
  
  onLogsLine: (callback: (data: { streamId: string; file: string; line: string }) => void) => {
    if (!eventListeners.has('logs/line')) {
      eventListeners.set('logs/line', new Set());
    }
    eventListeners.get('logs/line')!.add(callback);
    return () => {
      eventListeners.get('logs/line')?.delete(callback);
    };
  },
  
  onLogsStopped: (callback: (data: { streamId: string; reason: string; message?: string }) => void) => {
    if (!eventListeners.has('logs/stopped')) {
      eventListeners.set('logs/stopped', new Set());
    }
    eventListeners.get('logs/stopped')!.add(callback);
    return () => {
      eventListeners.get('logs/stopped')?.delete(callback);
    };
  },

  // Remove listeners
  removeAllListeners: (channel: string) => {
    eventListeners.delete(channel);
  }
};

// Check if we're in Electron or browser
if (typeof window !== 'undefined') {
  if (!window.electronAPI) {
    // Browser mode - use web API
    (window as any).electronAPI = webAPI;
    console.log('🌐 Running in web mode - API:', API_BASE_URL);
  } else {
    // Electron mode - use existing API
    console.log('⚡ Running in Electron mode');
  }
}

