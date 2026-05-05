#!/usr/bin/env node
// Minimal supervisor + docker bridge — zero npm dependencies, Node built-ins only.
// WebSocket server multiplexes stats, procs, supervisor-status, and log streaming
// over a single persistent connection per client.

'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.API_PORT || 28000);
const HOST = process.env.LISTEN_HOST || '127.0.0.1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runLocal(cmd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ exitCode: code, output: out, stderr: err }));
    child.on('error', (e) => resolve({ exitCode: 1, output: '', stderr: e.message }));
  });
}

function quote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }

function parseServices(text) {
  return String(text).trim().split('\n')
    .filter(l => l.trim())
    .map(line => {
      const m = line.trim().match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
      if (!m) return null;
      const name = m[1];
      const idx = name.indexOf(':');
      return {
        name,
        group: idx === -1 ? null : name.slice(0, idx),
        program: idx === -1 ? name : name.slice(idx + 1),
        state: m[2],
        extra: m[3] || '',
      };
    })
    .filter(Boolean);
}

function getQueryParams(req) {
  const qIdx = req.url.indexOf('?');
  if (qIdx === -1) return {};
  return Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
  });
}

// Build the shell command for a set of files/docker sources
function buildLogCmd(files, mode, n) {
  if (files.length === 1 && files[0].startsWith('/docker/')) {
    const name = files[0].slice('/docker/'.length);
    return mode === 'follow'
      ? `docker logs --tail ${n} -f ${quote(name)} 2>&1`
      : `docker logs --tail ${n} ${quote(name)} 2>&1`;
  }
  const safeFiles = files.map(f => quote(f)).join(' ');
  return mode === 'follow' ? `tail -f ${safeFiles}` : `tail -n ${n} ${safeFiles}`;
}

// ─── Machine stats collector ──────────────────────────────────────────────────

async function collectMachineStats() {
  const [cpuMem, disk, loadAvg, memInfo] = await Promise.all([
    runLocal("top -bn1 | grep '^%Cpu' | awk '{print $2+$4}'"),
    runLocal("df -h / | awk 'NR==2{print $2,$3,$4,$5}'"),
    runLocal("cat /proc/loadavg"),
    runLocal("awk '/^MemTotal|^MemAvailable/{print $1,$2}' /proc/meminfo"),
  ]);

  const memLines = memInfo.output.trim().split('\n');
  let memTotalKb = 0, memAvailKb = 0;
  for (const l of memLines) {
    const [key, val] = l.split(/\s+/);
    if (key === 'MemTotal:') memTotalKb = parseInt(val);
    if (key === 'MemAvailable:') memAvailKb = parseInt(val);
  }
  const memUsedKb = memTotalKb - memAvailKb;
  const diskParts = disk.output.trim().split(/\s+/);
  const loadParts = loadAvg.output.trim().split(/\s+/);

  return {
    cpu: { usedPct: parseFloat(cpuMem.output.trim()) || 0 },
    memory: {
      totalKb: memTotalKb,
      usedKb: memUsedKb,
      availKb: memAvailKb,
      usedPct: memTotalKb ? Math.round((memUsedKb / memTotalKb) * 100) : 0,
    },
    disk: {
      total: diskParts[0] || '?',
      used: diskParts[1] || '?',
      avail: diskParts[2] || '?',
      usedPct: parseInt(diskParts[3]) || 0,
    },
    load: {
      avg1: parseFloat(loadParts[0]) || 0,
      avg5: parseFloat(loadParts[1]) || 0,
      avg15: parseFloat(loadParts[2]) || 0,
    },
  };
}

// Parse PID from the supervisorctl status "extra" field: "pid 1234, uptime 0:01:23"
function parsePid(extra) {
  const m = extra && extra.match(/pid\s+(\d+)/);
  return m ? parseInt(m[1]) : null;
}

async function collectProcs() {
  // One supervisorctl call — PIDs are already in the status output
  const sr = await runLocal('sudo supervisorctl status all');
  const services = parseServices(sr.output).filter(s => s.state === 'RUNNING');

  // Extract all PIDs and do a single ps call for all of them at once
  const withPids = services.map(s => ({ ...s, pid: parsePid(s.extra) })).filter(s => s.pid);
  if (withPids.length === 0) return services.map(s => ({ name: s.name, pid: null, cpu: null, memKb: null }));

  const pidList = withPids.map(s => s.pid).join(',');
  const ps = await runLocal(`ps -p ${pidList} -o pid,%cpu,rss --no-headers 2>/dev/null`);

  // Build a map of pid → { cpu, memKb }
  const pidStats = {};
  for (const line of ps.output.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) {
      pidStats[parseInt(parts[0])] = { cpu: parseFloat(parts[1]) || 0, memKb: parseInt(parts[2]) || 0 };
    }
  }

  return withPids.map(s => ({
    name: s.name,
    pid: s.pid,
    cpu: pidStats[s.pid]?.cpu ?? null,
    memKb: pidStats[s.pid]?.memKb ?? null,
  }));
}

// ─── WebSocket server (pure Node — no ws package) ────────────────────────────
// Implements RFC 6455 handshake + framing for text frames only.

const crypto = require('crypto');

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

// Decode a single WebSocket frame from a Buffer. Returns { payload, consumed } or null if incomplete.
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + payloadLen) return null;

  let payload = buf.slice(offset + maskLen, offset + maskLen + payloadLen);
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }

  return { opcode, payload, consumed: offset + maskLen + payloadLen };
}

// Encode a text message as an unmasked WebSocket frame.
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Send a typed WS message to a socket.
function wsSend(socket, type, payload) {
  if (socket.destroyed) return;
  try {
    socket.write(encodeFrame(JSON.stringify({ type, ...payload })));
  } catch { /* ignore */ }
}

// ─── Per-client session ───────────────────────────────────────────────────────

// Global push loops (shared across all clients — only run when at least one subscriber)
let statsSubscribers = new Set();   // sockets subscribed to machine stats
let procsSubscribers = new Set();   // sockets subscribed to supervisor procs
let statusSubscribers = new Set();  // sockets subscribed to supervisor status

let statsTimer = null;
let procsTimer = null;
let statusTimer = null;

const STATS_INTERVAL_MS  = 5000;
const PROCS_INTERVAL_MS  = 5000;
const STATUS_INTERVAL_MS = 10000;

function broadcastStats() {
  if (statsSubscribers.size === 0) return;
  collectMachineStats().then(stats => {
    for (const sock of statsSubscribers) wsSend(sock, 'stats', { success: true, ...stats });
  }).catch(() => {});
}

function broadcastProcs() {
  if (procsSubscribers.size === 0) return;
  collectProcs().then(procs => {
    for (const sock of procsSubscribers) wsSend(sock, 'procs', { success: true, procs });
  }).catch(() => {});
}

function broadcastStatus() {
  if (statusSubscribers.size === 0) return;
  runLocal('sudo supervisorctl status all').then(r => {
    const services = parseServices(r.output);
    for (const sock of statusSubscribers) wsSend(sock, 'supervisor-status', { success: true, services });
  }).catch(() => {});
}

function ensureStatsLoop()  { if (!statsTimer)  statsTimer  = setInterval(broadcastStats,  STATS_INTERVAL_MS); }
function ensureProcsLoop()  { if (!procsTimer)  procsTimer  = setInterval(broadcastProcs,  PROCS_INTERVAL_MS); }
function ensureStatusLoop() { if (!statusTimer) statusTimer = setInterval(broadcastStatus, STATUS_INTERVAL_MS); }

function maybeStopStatsLoop()  { if (statsSubscribers.size  === 0 && statsTimer)  { clearInterval(statsTimer);  statsTimer  = null; } }
function maybeStopProcsLoop()  { if (procsSubscribers.size  === 0 && procsTimer)  { clearInterval(procsTimer);  procsTimer  = null; } }
function maybeStopStatusLoop() { if (statusSubscribers.size === 0 && statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

// Per-client log streams: streamId → child process
const activeLogStreams = new Map();

function handleWsClient(socket, req) {
  let rxBuf = Buffer.alloc(0);

  // Track which subscriptions this client holds (for cleanup on disconnect)
  const mySubscriptions = new Set();

  // Track this client's log streams for cleanup
  const myLogStreams = new Set();

  socket.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    while (true) {
      const frame = decodeFrame(rxBuf);
      if (!frame) break;
      rxBuf = rxBuf.slice(frame.consumed);

      if (frame.opcode === 0x8) { // close
        socket.destroy();
        break;
      }
      if (frame.opcode === 0x9) { // ping → pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a; pong[1] = 0;
        socket.write(pong);
        continue;
      }
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue; // only text/binary

      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }

      handleWsMessage(socket, msg, mySubscriptions, myLogStreams);
    }
  });

  socket.on('close', () => cleanup(socket, mySubscriptions, myLogStreams));
  socket.on('error', () => cleanup(socket, mySubscriptions, myLogStreams));
}

function handleWsMessage(socket, msg, mySubscriptions, myLogStreams) {
  const { type, id } = msg;

  // ── subscribe: stats ──────────────────────────────────────────────────────
  if (type === 'subscribe:stats') {
    statsSubscribers.add(socket);
    mySubscriptions.add('stats');
    ensureStatsLoop();
    // Send immediately
    collectMachineStats().then(stats => wsSend(socket, 'stats', { success: true, ...stats })).catch(() => {});
    return;
  }
  if (type === 'unsubscribe:stats') {
    statsSubscribers.delete(socket);
    mySubscriptions.delete('stats');
    maybeStopStatsLoop();
    return;
  }

  // ── subscribe: procs ──────────────────────────────────────────────────────
  if (type === 'subscribe:procs') {
    procsSubscribers.add(socket);
    mySubscriptions.add('procs');
    ensureProcsLoop();
    collectProcs().then(procs => wsSend(socket, 'procs', { success: true, procs })).catch(() => {});
    return;
  }
  if (type === 'unsubscribe:procs') {
    procsSubscribers.delete(socket);
    mySubscriptions.delete('procs');
    maybeStopProcsLoop();
    return;
  }

  // ── subscribe: supervisor-status ──────────────────────────────────────────
  if (type === 'subscribe:supervisor-status') {
    statusSubscribers.add(socket);
    mySubscriptions.add('supervisor-status');
    ensureStatusLoop();
    runLocal('sudo supervisorctl status all').then(r => {
      wsSend(socket, 'supervisor-status', { success: true, services: parseServices(r.output) });
    }).catch(() => {});
    return;
  }
  if (type === 'unsubscribe:supervisor-status') {
    statusSubscribers.delete(socket);
    mySubscriptions.delete('supervisor-status');
    maybeStopStatusLoop();
    return;
  }

  // ── logs: follow ──────────────────────────────────────────────────────────
  if (type === 'logs:follow') {
    const { files, lines = 200 } = msg;
    if (!Array.isArray(files) || files.length === 0) {
      wsSend(socket, 'logs:error', { id, error: 'files required' });
      return;
    }
    const streamId = id || `ws-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const n = Math.min(Number(lines), 500);
    const cmd = buildLogCmd(files, 'follow', n);
    const child = spawn('bash', ['-c', cmd], {
      env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });

    activeLogStreams.set(streamId, child);
    myLogStreams.add(streamId);
    wsSend(socket, 'logs:started', { streamId, files });

    let currentFile = files[0];
    let buf = '';

    function flushStream(stream) {
      stream.on('data', (d) => {
        buf += d.toString();
        const logLines = buf.split('\n');
        buf = logLines.pop();
        for (const line of logLines) {
          const header = line.match(/^==> (.+) <==$/);
          if (header) { currentFile = header[1]; continue; }
          if (line) wsSend(socket, 'logs:line', { streamId, file: currentFile, line });
        }
      });
    }

    flushStream(child.stdout);
    flushStream(child.stderr);

    child.on('close', () => {
      activeLogStreams.delete(streamId);
      myLogStreams.delete(streamId);
      wsSend(socket, 'logs:stopped', { streamId, reason: 'complete' });
    });
    return;
  }

  // ── logs: tail (one-shot) ─────────────────────────────────────────────────
  if (type === 'logs:tail') {
    const { files, lines = 200 } = msg;
    if (!Array.isArray(files) || files.length === 0) {
      wsSend(socket, 'logs:error', { id, error: 'files required' });
      return;
    }
    const streamId = id || `ws-snap-${Date.now()}`;
    const n = Math.min(Number(lines), 500);
    runLocal(buildLogCmd(files, 'last', n)).then(r => {
      const output = r.output || r.stderr || '';
      let currentFile = files[0];
      for (const line of output.split('\n')) {
        const header = line.match(/^==> (.+) <==$/);
        if (header) { currentFile = header[1]; continue; }
        if (line) wsSend(socket, 'logs:line', { streamId, file: currentFile, line });
      }
      wsSend(socket, 'logs:stopped', { streamId, reason: 'complete' });
    }).catch(e => wsSend(socket, 'logs:error', { id, error: String(e) }));
    return;
  }

  // ── logs: stop ────────────────────────────────────────────────────────────
  if (type === 'logs:stop') {
    const { streamId } = msg;
    const child = activeLogStreams.get(streamId);
    if (child) { child.kill(); activeLogStreams.delete(streamId); myLogStreams.delete(streamId); }
    wsSend(socket, 'logs:stopped', { streamId, reason: 'stopped' });
    return;
  }

  // ── supervisor: one-shot status ───────────────────────────────────────────
  if (type === 'supervisor:status') {
    runLocal('sudo supervisorctl status all').then(r => {
      wsSend(socket, 'supervisor-status', { success: true, services: parseServices(r.output) });
    }).catch(() => {});
    return;
  }
}

function cleanup(socket, mySubscriptions, myLogStreams) {
  if (mySubscriptions.has('stats'))             { statsSubscribers.delete(socket);  maybeStopStatsLoop(); }
  if (mySubscriptions.has('procs'))             { procsSubscribers.delete(socket);  maybeStopProcsLoop(); }
  if (mySubscriptions.has('supervisor-status')) { statusSubscribers.delete(socket); maybeStopStatusLoop(); }
  for (const streamId of myLogStreams) {
    const child = activeLogStreams.get(streamId);
    if (child) { child.kill(); activeLogStreams.delete(streamId); }
  }
}

// ─── HTTP route handlers ──────────────────────────────────────────────────────

async function handleStatus(res) {
  const r = await runLocal('sudo supervisorctl status all');
  json(res, 200, { success: true, services: parseServices(r.output) });
}

async function handleControl(req, res) {
  const body = await readBody(req);
  const { serviceName, operation } = body;
  if (!['start', 'stop', 'restart'].includes(operation) || !serviceName)
    return json(res, 400, { success: false, error: 'Bad request' });
  await runLocal(`sudo supervisorctl ${operation} ${quote(serviceName)}`);
  const sr = await runLocal(`sudo supervisorctl status ${quote(serviceName)}`);
  const updated = parseServices(sr.output);
  // Push updated status to all subscribers after a control action
  if (statusSubscribers.size > 0) broadcastStatus();
  json(res, 200, {
    success: true,
    serviceName,
    newState: updated[0]?.state || (operation === 'stop' ? 'STOPPED' : 'RUNNING'),
  });
}

async function handleBulk(req, res) {
  const body = await readBody(req);
  const { serviceNames, operation } = body;
  if (!['start', 'stop', 'restart'].includes(operation) || !Array.isArray(serviceNames))
    return json(res, 400, { success: false, error: 'Bad request' });
  const results = [];
  for (const name of serviceNames) {
    await runLocal(`sudo supervisorctl ${operation} ${quote(name)}`);
    const sr = await runLocal(`sudo supervisorctl status ${quote(name)}`);
    const updated = parseServices(sr.output);
    results.push({
      serviceName: name,
      success: true,
      newState: updated[0]?.state || (operation === 'stop' ? 'STOPPED' : 'RUNNING'),
    });
  }
  if (statusSubscribers.size > 0) broadcastStatus();
  json(res, 200, { success: true, results });
}

async function handleLogsList(res) {
  const [logsResult, dockerResult] = await Promise.all([
    runLocal('ls /opt/fundbox/logs/*.log 2>/dev/null'),
    runLocal(`docker ps -a --format '{{.Names}}'`),
  ]);
  const logFiles = logsResult.output.trim().split('\n').filter(Boolean).sort();
  const dockerFiles = dockerResult.output.trim().split('\n').filter(Boolean)
    .map(name => `/docker/${name}`);
  json(res, 200, { success: true, files: [...logFiles, ...dockerFiles] });
}

async function handleLogsTail(req, res) {
  const body = await readBody(req);
  const { files, lines } = body;
  if (!Array.isArray(files) || files.length === 0)
    return json(res, 400, { success: false, error: 'files required' });
  const n = Math.min(Number(lines) || 200, 500);
  const r = await runLocal(buildLogCmd(files, 'last', n));
  json(res, 200, { success: true, output: r.output || r.stderr });
}

// Keep SSE log streaming for backwards-compat (nginx already has proxy_buffering off for it)
function handleLogsStream(req, res) {
  const params = getQueryParams(req);
  const files = (params.files || '').split(',').map(f => decodeURIComponent(f)).filter(Boolean);
  const n = Math.min(Number(params.lines) || 200, 500);
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (files.length === 0) { res.writeHead(400); res.end('files required'); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Stream-Id': streamId,
  });

  res.write(`event: streamId\ndata: ${JSON.stringify({ streamId })}\n\n`);

  const cmd = buildLogCmd(files, 'follow', n);
  const child = spawn('bash', ['-c', cmd], {
    env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });

  activeLogStreams.set(streamId, child);
  let currentFile = files[0];
  let buf = '';

  function flush(stream) {
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const header = line.match(/^==> (.+) <==$/);
        if (header) { currentFile = header[1]; continue; }
        if (line) res.write(`event: line\ndata: ${JSON.stringify({ streamId, file: currentFile, line })}\n\n`);
      }
    });
  }

  flush(child.stdout);
  flush(child.stderr);

  child.on('close', () => {
    activeLogStreams.delete(streamId);
    if (!res.writableEnded) {
      res.write(`event: stopped\ndata: ${JSON.stringify({ streamId, reason: 'complete' })}\n\n`);
      res.end();
    }
  });

  req.on('close', () => { activeLogStreams.delete(streamId); child.kill(); });
}

async function handleLogsStop(req, res) {
  const body = await readBody(req);
  const { streamId } = body;
  const child = activeLogStreams.get(streamId);
  if (child) { child.kill(); activeLogStreams.delete(streamId); }
  json(res, 200, { success: true });
}

async function handleCommand(req, res) {
  const body = await readBody(req);
  const { command } = body;
  if (!command) return json(res, 400, { success: false, error: 'command required' });
  const r = await runLocal(command);
  json(res, 200, { success: r.exitCode === 0, exitCode: r.exitCode, output: r.output });
}

async function handleSupervisorVenvs(res) {
  const r = await runLocal("ls /opt/fundbox/venvs/ 2>/dev/null");
  const names = r.output.trim().split('\n').filter(Boolean);
  const venvs = {};
  await Promise.all(names.map(async name => {
    const pr = await runLocal(`/opt/fundbox/venvs/${quote(name)}/bin/python3 --version 2>&1`);
    const m = pr.output.match(/Python (\S+)/);
    if (m) venvs[name] = m[1];
  }));
  json(res, 200, { success: true, venvs });
}

async function handleDockerContainers(res) {
  const r = await runLocal(
    `docker ps -a --format '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}'`
  );
  const containers = r.output.trim().split('\n')
    .filter(l => l.trim())
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  json(res, 200, { success: true, containers });
}

async function handleDockerAction(req, res) {
  const body = await readBody(req);
  const { containerId, action } = body;
  if (!['start', 'stop', 'restart'].includes(action) || !containerId)
    return json(res, 400, { success: false, error: 'Bad request' });
  const r = await runLocal(`docker ${action} ${quote(containerId)}`);
  json(res, 200, { success: r.exitCode === 0, output: r.output, stderr: r.stderr });
}

// ─── HTTP server + WS upgrade ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url.replace(/\?.*$/, '');
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  console.log(`[${new Date().toISOString()}] ${method} ${url}`);

  try {
    if (url === '/api/supervisor/status'  && method === 'GET')  return await handleStatus(res);
    if (url === '/api/supervisor/restart' && method === 'POST') return await handleControl(req, res);
    if (url === '/api/supervisor/start'   && method === 'POST') return await handleControl(req, res);
    if (url === '/api/supervisor/stop'    && method === 'POST') return await handleControl(req, res);
    if (url === '/api/supervisor/bulk'    && method === 'POST') return await handleBulk(req, res);
    if (url === '/api/supervisor/venvs'   && method === 'GET')  return await handleSupervisorVenvs(res);
    if (url === '/api/logs/list'          && method === 'GET')  return await handleLogsList(res);
    if (url === '/api/logs/tail'          && method === 'POST') return await handleLogsTail(req, res);
    if (url === '/api/logs/stream'        && method === 'GET')  return handleLogsStream(req, res);
    if (url === '/api/logs/stop'          && method === 'POST') return await handleLogsStop(req, res);
    if (url === '/api/command/execute'    && method === 'POST') return await handleCommand(req, res);
    if (url === '/api/docker/containers'  && method === 'GET')  return await handleDockerContainers(res);
    if (url === '/api/docker/action'      && method === 'POST') return await handleDockerAction(req, res);
    if (url === '/api/rde/status'         && method === 'GET')  return json(res, 200, { connected: true, target: 'local' });
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('Handler error:', e);
    json(res, 500, { error: String(e) });
  }
});

// Handle WebSocket upgrade on /api/ws
server.on('upgrade', (req, socket, head) => {
  const url = req.url.replace(/\?.*$/, '');
  if (url !== '/api/ws') { socket.destroy(); return; }
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }

  if (!wsHandshake(req, socket)) return;

  // Prepend any bytes that arrived with the upgrade
  if (head && head.length > 0) socket.unshift(head);

  console.log(`[${new Date().toISOString()}] WS connected`);
  handleWsClient(socket, req);
});

server.listen(PORT, HOST, () => {
  console.log(`[rde-ui] bridge listening on ${HOST}:${PORT}`);
});
