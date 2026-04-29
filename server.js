#!/usr/bin/env node
// Minimal supervisor + docker bridge — zero npm dependencies, Node built-ins only.

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

// ─── Active SSE streams ───────────────────────────────────────────────────────

const activeStreams = new Map(); // streamId → child process

// ─── Route handlers ───────────────────────────────────────────────────────────

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

// POST /api/logs/tail — one-shot snapshot (mode=last)
async function handleLogsTail(req, res) {
  const body = await readBody(req);
  const { files, lines } = body;
  if (!Array.isArray(files) || files.length === 0)
    return json(res, 400, { success: false, error: 'files required' });
  const n = Math.min(Number(lines) || 200, 500);
  const r = await runLocal(buildLogCmd(files, 'last', n));
  json(res, 200, { success: true, output: r.output || r.stderr });
}

// GET /api/logs/stream?files=...&lines=N — SSE live stream (mode=follow)
function handleLogsStream(req, res) {
  const params = getQueryParams(req);
  const files = (params.files || '').split(',').map(f => decodeURIComponent(f)).filter(Boolean);
  const n = Math.min(Number(params.lines) || 200, 500);
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (files.length === 0) {
    res.writeHead(400); res.end('files required');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Stream-Id': streamId,
  });

  // Send streamId immediately so the client can reference it for stop
  res.write(`event: streamId\ndata: ${JSON.stringify({ streamId })}\n\n`);

  const cmd = buildLogCmd(files, 'follow', n);
  const child = spawn('bash', ['-c', cmd], {
    env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });

  activeStreams.set(streamId, child);

  let currentFile = files[0];
  let buf = '';

  function flush(stream) {
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        // tail -f emits ==> /path/to/file <== when following multiple files
        const header = line.match(/^==> (.+) <==$/);
        if (header) { currentFile = header[1]; continue; }
        if (line) {
          res.write(`event: line\ndata: ${JSON.stringify({ streamId, file: currentFile, line })}\n\n`);
        }
      }
    });
  }

  flush(child.stdout);
  flush(child.stderr); // docker logs writes to stderr

  child.on('close', () => {
    activeStreams.delete(streamId);
    if (!res.writableEnded) {
      res.write(`event: stopped\ndata: ${JSON.stringify({ streamId, reason: 'complete' })}\n\n`);
      res.end();
    }
  });

  // Clean up if client disconnects
  req.on('close', () => {
    activeStreams.delete(streamId);
    child.kill();
  });
}

// POST /api/logs/stop
async function handleLogsStop(req, res) {
  const body = await readBody(req);
  const { streamId } = body;
  const child = activeStreams.get(streamId);
  if (child) {
    child.kill();
    activeStreams.delete(streamId);
  }
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

// ─── Router ───────────────────────────────────────────────────────────────────

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

server.listen(PORT, HOST, () => {
  console.log(`[rde-ui] bridge listening on ${HOST}:${PORT}`);
});
