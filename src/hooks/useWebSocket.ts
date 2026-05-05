/**
 * Singleton WebSocket connection to the RDE bridge at /rde-api/ws.
 *
 * All components subscribe to typed topics via the returned helpers.
 * The socket reconnects automatically with exponential backoff.
 *
 * Message protocol (both directions are JSON objects with a `type` field):
 *
 *   Client → Server:
 *     { type: 'subscribe:stats' }
 *     { type: 'unsubscribe:stats' }
 *     { type: 'subscribe:procs' }
 *     { type: 'unsubscribe:procs' }
 *     { type: 'subscribe:supervisor-status' }
 *     { type: 'unsubscribe:supervisor-status' }
 *     { type: 'supervisor:status' }                    — one-shot fetch
 *     { type: 'logs:follow', id, files, lines }
 *     { type: 'logs:tail',   id, files, lines }
 *     { type: 'logs:stop',   streamId }
 *
 *   Server → Client:
 *     { type: 'stats',             success, cpu, memory, disk, load }
 *     { type: 'procs',             success, procs }
 *     { type: 'supervisor-status', success, services }
 *     { type: 'logs:started',      streamId, files }
 *     { type: 'logs:line',         streamId, file, line }
 *     { type: 'logs:stopped',      streamId, reason }
 *     { type: 'logs:error',        id, error }
 */

type Listener = (msg: Record<string, unknown>) => void;

const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30_000;

// Messages queued while the socket is not yet open
const sendQueue: string[] = [];

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/rde-api/ws`;
}

function dispatch(type: string, msg: Record<string, unknown>) {
  listeners.get(type)?.forEach(cb => cb(msg));
  // Also dispatch to wildcard listeners
  listeners.get('*')?.forEach(cb => cb(msg));
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  socket = new WebSocket(getWsUrl());

  socket.onopen = () => {
    console.log('[ws] connected');
    reconnectDelay = 1000;
    // Flush queued messages
    while (sendQueue.length) {
      socket!.send(sendQueue.shift()!);
    }
    dispatch('ws:open', {});
  };

  socket.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(e.data); } catch { return; }
    const type = msg.type as string;
    if (type) dispatch(type, msg);
  };

  socket.onclose = () => {
    console.log(`[ws] closed — reconnecting in ${reconnectDelay}ms`);
    dispatch('ws:close', {});
    socket = null;
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      connect();
    }, reconnectDelay);
  };

  socket.onerror = () => {
    // onclose fires right after, which handles reconnect
  };
}

export function send(msg: Record<string, unknown>) {
  const payload = JSON.stringify(msg);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(payload);
  } else {
    sendQueue.push(payload);
    connect();
  }
}

export function on(type: string, cb: Listener): () => void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(cb);
  return () => { listeners.get(type)?.delete(cb); };
}

// Start the connection as soon as this module is imported
if (typeof window !== 'undefined') connect();
