const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const swaggerUi = require('swagger-ui-express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const DIST_DIR = path.join(__dirname, 'dist');
const API_PORT = Number(process.env.API_PORT || process.env.PORT || 20000);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 20001);
/** Use 127.0.0.1 when TLS nginx binds the public ports (see deployment/rde/nginx-rde-ui.conf). */
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';

const apiApp = express();
apiApp.use(cors({ origin: true }));
apiApp.use(express.json());

// Request logging (API)
apiApp.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [api] ${req.method} ${req.path}`);
  next();
});

// WebSocket server for real-time streaming
const wss = new WebSocket.Server({ noServer: true });

function sendToClients(channel, data) {
  const message = JSON.stringify({ channel, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); } catch (_) {}
    }
  });
}

wss.on('connection', (ws) => {
  ws.on('error', (e) => console.error('[WS] error:', e));
  ws.send(JSON.stringify({
    channel: 'rde/status',
    data: { state: 'connected', message: 'Running on RDE' }
  }));
});

// ─── Helper: run a local command and return its output ───────────────────────

function runLocal(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
    });

    const stdoutLines = [];
    let stderr = '';

    child.stdout.on('data', (d) => {
      const text = d.toString();
      text.split('\n').forEach(line => {
        if (line.trim()) stdoutLines.push(line);
      });
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      resolve({ exitCode: code, output: stdoutLines.join('\n'), stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, output: '', stderr: err.message });
    });
  });
}

// ─── Supervisor helpers ───────────────────────────────────────────────────────

const SUPERVISOR_CONFIG_SCRIPT = path.join(
  __dirname,
  'deployment/rde/scripts/supervisor_process_config.py'
);

function bashSingleQuoted(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function splitSupervisorName(fullName) {
  const idx = fullName.indexOf(':');
  if (idx === -1) return { group: null, program: fullName };
  return { group: fullName.slice(0, idx), program: fullName.slice(idx + 1) };
}

function parseSupervisorStatusLines(text) {
  const services = [];
  for (const line of String(text).trim().split('\n')) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
    if (match) {
      const name = match[1];
      const { group, program } = splitSupervisorName(name);
      services.push({
        name,
        group,
        program,
        state: match[2],
        extra: match[3] || ''
      });
    }
  }
  return services;
}

/** target: 'all' | full process name | internal 'group:GROUP' for status group:* */
async function runSupervisorctlStatus(target) {
  let cmd;
  if (target === 'all') {
    cmd = 'sudo supervisorctl status all';
  } else if (typeof target === 'string' && target.startsWith('group:')) {
    const g = target.slice('group:'.length);
    cmd = `sudo supervisorctl status ${bashSingleQuoted(`${g}:*`)}`;
  } else {
    cmd = `sudo supervisorctl status ${bashSingleQuoted(target)}`;
  }
  return runLocal(cmd);
}

async function getSupervisorServicesAll() {
  const result = await runSupervisorctlStatus('all');
  const services = parseSupervisorStatusLines(result.output);
  return { result, services };
}

function buildGroupSummaries(services) {
  const map = new Map();
  for (const s of services) {
    const g = s.group == null ? 'ungrouped' : s.group;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(s.name);
  }
  return [...map.entries()]
    .map(([name, members]) => ({ name, memberCount: members.length, members: members.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function controlSuccessForOutput(operation, identifier, output) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (operation === 'stop') {
    return new RegExp(`${escaped}:\\s*stopped`, 'i').test(output);
  }
  if (operation === 'restart') {
    return (
      new RegExp(`${escaped}:\\s*started`, 'i').test(output) ||
      new RegExp(`${escaped}:\\s*restarted`, 'i').test(output)
    );
  }
  return new RegExp(`${escaped}:\\s*started`, 'i').test(output);
}

// ─── Status: always connected (server IS the RDE) ────────────────────────────

apiApp.get('/api/rde/status', (_req, res) => {
  res.json({ connected: true, target: 'local', pid: process.pid });
});

// No-op connect/disconnect kept for API compatibility with the frontend
apiApp.post('/api/rde/connect', (_req, res) => {
  sendToClients('rde/status', { state: 'connected', message: 'Running on RDE' });
  res.json({ success: true });
});

apiApp.post('/api/rde/disconnect', (_req, res) => {
  res.json({ success: true });
});

// ─── Supervisor ───────────────────────────────────────────────────────────────

apiApp.get('/api/supervisor/status', async (_req, res) => {
  console.log('[supervisor/status] running supervisorctl...');
  const { result, services } = await getSupervisorServicesAll();
  console.log('[supervisor/status] exit:', result.exitCode, 'lines:', services.length, 'stderr:', result.stderr?.substring(0, 100));

  console.log('[supervisor/status] parsed', services.length, 'services');
  sendToClients('supervisor/statusResult', { services });
  res.json({ success: true, services });
});

/** Same processes as status, explicit list endpoint for APIs / MCP */
apiApp.get('/api/supervisor/services', async (_req, res) => {
  const { result, services } = await getSupervisorServicesAll();
  if (result.exitCode !== 0 && services.length === 0) {
    return res.status(502).json({
      success: false,
      error: result.stderr || 'supervisorctl failed',
      exitCode: result.exitCode
    });
  }
  res.json({ success: true, services });
});

/** Distinct group names (supervisor "group" prefix before ':') plus ungrouped */
apiApp.get('/api/supervisor/groups', async (_req, res) => {
  const { result, services } = await getSupervisorServicesAll();
  if (result.exitCode !== 0 && services.length === 0) {
    return res.status(502).json({
      success: false,
      error: result.stderr || 'supervisorctl failed',
      exitCode: result.exitCode
    });
  }
  res.json({ success: true, groups: buildGroupSummaries(services) });
});

/**
 * Query exactly one of: name=<full process name> | group=<group name>
 * Returns matching process rows (same shape as /services).
 */
apiApp.get('/api/supervisor/state', async (req, res) => {
  const name = req.query.name;
  const group = req.query.group;
  const hasName = name != null && String(name).trim() !== '';
  const hasGroup = group != null && String(group).trim() !== '';
  if (hasName === hasGroup) {
    return res.status(400).json({
      success: false,
      error: 'Provide exactly one of: query param name or group'
    });
  }
  if (/[\n\r\0]/.test(String(hasName ? name : group))) {
    return res.status(400).json({ success: false, error: 'Invalid name or group' });
  }

  const target = hasName ? String(name).trim() : `group:${String(group).trim()}`;
  const result = await runSupervisorctlStatus(target);
  const services = parseSupervisorStatusLines(result.output);
  res.json({
    success: result.exitCode === 0 || services.length > 0,
    services,
    exitCode: result.exitCode,
    stderr: result.stderr || undefined
  });
});

/**
 * Body: { operation: 'start'|'stop'|'restart', scope: 'name'|'group', identifier: string }
 * For scope group, identifier is the group name (supervisor applies group:*).
 */
apiApp.post('/api/supervisor/control', async (req, res) => {
  const { operation, scope, identifier } = req.body || {};
  const ops = ['start', 'stop', 'restart'];
  if (!ops.includes(operation)) {
    return res.status(400).json({ success: false, error: 'operation must be start, stop, or restart' });
  }
  if (scope !== 'name' && scope !== 'group') {
    return res.status(400).json({ success: false, error: 'scope must be name or group' });
  }
  if (identifier == null || String(identifier).trim() === '') {
    return res.status(400).json({ success: false, error: 'identifier is required' });
  }
  const id = String(identifier).trim();
  if (/[\n\r\0]/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid identifier' });
  }

  const ctlArg = scope === 'group' ? bashSingleQuoted(`${id}:*`) : bashSingleQuoted(id);
  const result = await runLocal(`sudo supervisorctl ${operation} ${ctlArg}`);
  const output = result.output + (result.stderr ? `\n${result.stderr}` : '');

  let ok = result.exitCode === 0;
  if (ok && scope === 'name') {
    ok = controlSuccessForOutput(operation, id, output);
  }

  res.json({
    success: ok,
    operation,
    scope,
    identifier: id,
    exitCode: result.exitCode,
    output: result.output,
    stderr: result.stderr || undefined
  });
});

/** Full supervisord config entry for a process (XML-RPC getAllConfigInfo), keyed by exact process name */
apiApp.get('/api/supervisor/config', async (req, res) => {
  const name = req.query.name;
  if (name == null || String(name).trim() === '') {
    return res.status(400).json({ success: false, error: 'Query param name is required (full supervisor process name)' });
  }
  const n = String(name).trim();
  if (/[\n\r\0]/.test(n)) {
    return res.status(400).json({ success: false, error: 'Invalid name' });
  }
  if (!fs.existsSync(SUPERVISOR_CONFIG_SCRIPT)) {
    return res.status(500).json({ success: false, error: 'supervisor_process_config.py not found on server' });
  }

  const cmd = `sudo python3 ${bashSingleQuoted(SUPERVISOR_CONFIG_SCRIPT)} ${bashSingleQuoted(n)}`;
  const result = await runLocal(cmd);
  let parsed = null;
  try {
    parsed = JSON.parse((result.output || '').trim() || '{}');
  } catch {
    return res.status(502).json({
      success: false,
      error: 'Invalid JSON from config helper',
      raw: result.output,
      stderr: result.stderr
    });
  }
  if (parsed.error) {
    const status = parsed.error === 'not_found' ? 404 : 502;
    return res.status(status).json({
      success: false,
      error: parsed.error,
      detail: parsed.detail || parsed.name,
      stderr: result.stderr
    });
  }
  res.json({ success: true, name: n, config: parsed });
});

apiApp.post('/api/supervisor/restart', async (req, res) => {
  const { serviceName } = req.body;
  const result = await runLocal(`sudo supervisorctl restart ${serviceName}`);
  const output = result.output;
  const started = new RegExp(`${serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*started`, 'i').test(output);
  res.json(started
    ? { success: true, serviceName, newState: 'RUNNING', output }
    : { success: false, error: 'Could not confirm restart', output });
});

apiApp.post('/api/supervisor/start', async (req, res) => {
  const { serviceName } = req.body;
  const result = await runLocal(`sudo supervisorctl start ${serviceName}`);
  const output = result.output;
  const started = new RegExp(`${serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*started`, 'i').test(output);
  res.json(started
    ? { success: true, serviceName, newState: 'RUNNING', output }
    : { success: false, error: 'Could not confirm start', output });
});

apiApp.post('/api/supervisor/stop', async (req, res) => {
  const { serviceName } = req.body;
  const result = await runLocal(`sudo supervisorctl stop ${serviceName}`);
  const output = result.output;
  const stopped = new RegExp(`${serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*stopped`, 'i').test(output);
  res.json(stopped
    ? { success: true, serviceName, newState: 'STOPPED', output }
    : { success: false, error: 'Could not confirm stop', output });
});

apiApp.post('/api/supervisor/bulk', async (req, res) => {
  const { serviceNames, operation } = req.body;
  const results = [];

  for (const serviceName of serviceNames) {
    const result = await runLocal(`sudo supervisorctl ${operation} ${serviceName}`);
    const output = result.output;
    const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startedPattern = new RegExp(`${escaped}:\\s*started`, 'i');
    const stoppedPattern = new RegExp(`${escaped}:\\s*stopped`, 'i');

    let success = false;
    let newState = null;
    if (operation === 'stop' && stoppedPattern.test(output)) { success = true; newState = 'STOPPED'; }
    else if (startedPattern.test(output)) { success = true; newState = 'RUNNING'; }

    results.push({ serviceName, success, newState, output });
  }

  res.json({ success: true, results });
});

// ─── Venv Python versions ─────────────────────────────────────────────────────

apiApp.get('/api/supervisor/venvs', async (_req, res) => {
  console.log('[venvs] reading python versions from /opt/fundbox/venvs/...');
  const result = await runLocal(
    'for v in /opt/fundbox/venvs/*/; do name=$(basename $v); ver=$($v/bin/python --version 2>&1 | grep -o "[0-9]\\+\\.[0-9]\\+\\.[0-9]\\+"); echo "$name:$ver"; done'
  );
  const venvs = {};
  for (const line of result.output.trim().split('\n')) {
    const [name, version] = line.split(':');
    if (name && version) venvs[name.trim()] = version.trim();
  }
  console.log('[venvs] found', Object.keys(venvs).length, 'venvs');
  res.json({ success: true, venvs });
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

apiApp.get('/api/logs/list', (_req, res) => {
  const files = [
    '/opt/fundbox/logs/agreements.log',
    '/opt/fundbox/logs/agreements_queue.log',
    '/opt/fundbox/logs/alerts.log',
    '/opt/fundbox/logs/api.log',
    '/opt/fundbox/logs/application.log',
    '/opt/fundbox/logs/application_queue.log',
    '/opt/fundbox/logs/audit_log.log',
    '/opt/fundbox/logs/audit_log_queue.log',
    '/opt/fundbox/logs/authentication.log',
    '/opt/fundbox/logs/authentication_queue.log',
    '/opt/fundbox/logs/backstop.log',
    '/opt/fundbox/logs/backstop_queue.log',
    '/opt/fundbox/logs/backy_api_gateway.log',
    '/opt/fundbox/logs/backy_permissions.log',
    '/opt/fundbox/logs/backy_permissions_queue.log',
    '/opt/fundbox/logs/bank_actions_gateway.log',
    '/opt/fundbox/logs/bank_actions_gateway_queue.log',
    '/opt/fundbox/logs/bank_events_proxy.log',
    '/opt/fundbox/logs/bi_features.log',
    '/opt/fundbox/logs/buyback.log',
    '/opt/fundbox/logs/buyers.log',
    '/opt/fundbox/logs/calculated_fields.log',
    '/opt/fundbox/logs/captain.log',
    '/opt/fundbox/logs/cashback.log',
    '/opt/fundbox/logs/cashflow_prediction.log',
    '/opt/fundbox/logs/checkout.log',
    '/opt/fundbox/logs/checkout_product.log',
    '/opt/fundbox/logs/checkout_webservice.log',
    '/opt/fundbox/logs/clear_django_sessions.log',
    '/opt/fundbox/logs/communication.log',
    '/opt/fundbox/logs/coupon.log',
    '/opt/fundbox/logs/credit.log',
    '/opt/fundbox/logs/credit_report.log',
    '/opt/fundbox/logs/data_plus.log',
    '/opt/fundbox/logs/decision.log',
    '/opt/fundbox/logs/direct_draw.log',
    '/opt/fundbox/logs/ds_aggregator.log',
    '/opt/fundbox/logs/entities.log',
    '/opt/fundbox/logs/feature_flags.log',
    '/opt/fundbox/logs/feature_generation_over_wh.log',
    '/opt/fundbox/logs/features_generation.log',
    '/opt/fundbox/logs/fetching.log',
    '/opt/fundbox/logs/fi_connect.log',
    '/opt/fundbox/logs/fraud.log',
    '/opt/fundbox/logs/frontend.log',
    '/opt/fundbox/logs/fundbox_business.log',
    '/opt/fundbox/logs/incoming_reports.log',
    '/opt/fundbox/logs/insights.log',
    '/opt/fundbox/logs/llm.log',
    '/opt/fundbox/logs/loan_api.log',
    '/opt/fundbox/logs/loanpro_gateway.log',
    '/opt/fundbox/logs/loanpro_payment_processing.log',
    '/opt/fundbox/logs/mca.log',
    '/opt/fundbox/logs/mca_payments.log',
    '/opt/fundbox/logs/messages.log',
    '/opt/fundbox/logs/mobile_apiApp.log',
    '/opt/fundbox/logs/ocr.log',
    '/opt/fundbox/logs/onboarding.log',
    '/opt/fundbox/logs/outbound_reporting.log',
    '/opt/fundbox/logs/payments.log',
    '/opt/fundbox/logs/personal_guarantee.log',
    '/opt/fundbox/logs/platform_accounts.log',
    '/opt/fundbox/logs/ppp.log',
    '/opt/fundbox/logs/preapproval.log',
    '/opt/fundbox/logs/pre_qual.log',
    '/opt/fundbox/logs/product_state.log',
    '/opt/fundbox/logs/promotions.log',
    '/opt/fundbox/logs/px_api.log',
    '/opt/fundbox/logs/queue_monitor.log',
    '/opt/fundbox/logs/recovery.log',
    '/opt/fundbox/logs/relations.log',
    '/opt/fundbox/logs/research_data_collection.log',
    '/opt/fundbox/logs/risk.log',
    '/opt/fundbox/logs/rules_engine.log',
    '/opt/fundbox/logs/scoring.log',
    '/opt/fundbox/logs/secured_payments.log',
    '/opt/fundbox/logs/spv.log',
    '/opt/fundbox/logs/sstorage_api.log',
    '/opt/fundbox/logs/sstorage_logic.log',
    '/opt/fundbox/logs/subscription.log',
    '/opt/fundbox/logs/tax_returns.log',
    '/opt/fundbox/logs/visitors.log',
    '/opt/fundbox/logs/xl.log',
  ].sort();
  res.json({ success: true, files });
});

const logStreams = new Map();

apiApp.post('/api/logs/tail', (req, res) => {
  const { files, mode, lines } = req.body;
  const streamId = `stream-${Date.now()}`;

  let command;
  if (mode === 'last') {
    command = `tail -n ${lines || 200} ${files.join(' ')}`;
  } else {
    command = `tail -f ${files.join(' ')}`;
  }

  const child = spawn('bash', ['-c', command], {
    env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
  });

  let fileIdx = 0;
  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      sendToClients('logs/line', {
        streamId,
        file: files[fileIdx % files.length] || files[0],
        line
      });
    });
  });

  child.on('close', () => {
    sendToClients('logs/stopped', { streamId, reason: 'completed', message: 'Stream completed' });
    logStreams.delete(streamId);
  });

  logStreams.set(streamId, { process: child });
  res.json({ success: true, streamId });
});

apiApp.post('/api/logs/stop', (req, res) => {
  const { streamId } = req.body;
  const stream = logStreams.get(streamId);
  if (stream) {
    stream.process.kill();
    logStreams.delete(streamId);
    sendToClients('logs/stopped', { streamId, reason: 'stopped', message: 'Stopped by user' });
  }
  res.json({ success: true });
});

// ─── Commands ─────────────────────────────────────────────────────────────────

apiApp.post('/api/command/execute', async (req, res) => {
  const { command } = req.body;
  const commandId = `cmd-${Date.now()}`;

  const child = spawn('bash', ['-c', command], {
    env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
  });

  child.stdout.on('data', (d) => {
    d.toString().split('\n').filter(l => l.trim()).forEach(line => {
      sendToClients('command/output', { id: commandId, source: 'stdout', text: line });
    });
  });

  child.stderr.on('data', (d) => {
    d.toString().split('\n').filter(l => l.trim()).forEach(line => {
      sendToClients('command/output', { id: commandId, source: 'stderr', text: line });
    });
  });

  child.on('close', async (code) => {
    const result = await runLocal(command);
    res.json({ success: code === 0, exitCode: code, output: result.output, commandId });
  });

  child.on('error', (err) => {
    res.json({ success: false, error: err.message, commandId });
  });
});

// ─── Docker ───────────────────────────────────────────────────────────────────

apiApp.get('/api/docker/containers', async (_req, res) => {
  console.log('[docker] listing containers...');
  const result = await runLocal(
    `docker ps -a --format '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}'`
  );
  const containers = result.output.trim().split('\n')
    .filter(l => l.trim())
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
  console.log('[docker] found', containers.length, 'containers');
  res.json({ success: true, containers });
});

apiApp.post('/api/docker/action', async (req, res) => {
  const { containerId, action } = req.body;
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) {
    return res.json({ success: false, error: 'Invalid action' });
  }
  console.log(`[docker] ${action} ${containerId}`);
  const result = await runLocal(`docker ${action} ${containerId}`);
  res.json({ success: result.exitCode === 0, output: result.output, stderr: result.stderr });
});

// ─── Git ──────────────────────────────────────────────────────────────────────

apiApp.get('/api/git/info', async (_req, res) => {
  const branchResult = await runLocal('cd /opt/fundbox/backend && git rev-parse --abbrev-ref HEAD');
  if (branchResult.exitCode !== 0) {
    return res.json({ success: false, error: branchResult.stderr || 'Failed to get git branch' });
  }

  const branch = branchResult.output.trim();
  const statusResult = await runLocal('cd /opt/fundbox/backend && git status --short');
  const changes = statusResult.output.trim().split('\n').filter(l => l.trim()).map(line => ({
    status: line.substring(0, 2),
    file: line.substring(3).trim()
  }));

  res.json({ success: true, branch, changes, hasChanges: changes.length > 0 });
});

apiApp.post('/api/git/diff', async (req, res) => {
  const { file } = req.body;
  if (!file) return res.json({ success: false, error: 'File path required' });

  const result = await runLocal(`cd /opt/fundbox/backend && git diff ${file}`);
  res.json({ success: result.exitCode === 0, diff: result.output, file });
});

// ─── OpenAPI / Swagger UI ─────────────────────────────────────────────────────

const OPENAPI_PATH = path.join(__dirname, 'openapi.json');
if (fs.existsSync(OPENAPI_PATH)) {
  const openApiDocument = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
  apiApp.get('/api/openapi.json', (_req, res) => {
    res.type('application/json').sendFile(OPENAPI_PATH);
  });
  apiApp.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'RDE UI API',
      customCss: '.swagger-ui .topbar { display: none }'
    })
  );
}

// ─── Frontend static (Vite base: /rde-ui/) ─────────────────────────────────────

const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const webApp = express();
webApp.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [web] ${req.method} ${req.path}`);
  next();
});

/** Same-origin /rde-api on the UI port → API (public URL; mirrors nginx) */
const rdeApiProxy = createProxyMiddleware('/rde-api', {
  target: `http://127.0.0.1:${API_PORT}`,
  changeOrigin: true,
  pathRewrite: { '^/rde-api': '/api' },
  ws: true
});
webApp.use(rdeApiProxy);

/** Legacy path (older nginx) */
const rdeUiApiProxy = createProxyMiddleware('/rde-ui/api', {
  target: `http://127.0.0.1:${API_PORT}`,
  changeOrigin: true,
  pathRewrite: { '^/rde-ui/api': '/api' },
  ws: true
});
webApp.use(rdeUiApiProxy);

webApp.get('/rde-ui', (_req, res) => res.redirect(302, '/rde-ui/'));
webApp.get('/', (_req, res) => res.redirect(302, '/rde-ui/'));
if (fs.existsSync(DIST_DIR)) {
  webApp.use('/rde-ui', express.static(DIST_DIR, { index: false }));
}
if (fs.existsSync(INDEX_HTML)) {
  webApp.get('/rde-ui/', (_req, res) => res.sendFile(INDEX_HTML));
  webApp.use('/rde-ui', (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(INDEX_HTML);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

const apiServer = apiApp.listen(API_PORT, LISTEN_HOST, () => {
  console.log(`[api] http://${LISTEN_HOST}:${API_PORT} (REST, WebSocket /api/ws; public /rde-api/* via UI port)`);
  if (fs.existsSync(OPENAPI_PATH)) {
    console.log(`[api] OpenAPI / Swagger UI: http://${LISTEN_HOST}:${API_PORT}/api/docs`);
  }
});

let webServer = null;
if (fs.existsSync(INDEX_HTML)) {
  webServer = webApp.listen(FRONTEND_PORT, LISTEN_HOST, () => {
    console.log(`[web] UI http://${LISTEN_HOST}:${FRONTEND_PORT}/rde-ui/`);
  });
} else {
  console.warn('[web] dist/index.html missing; frontend server not started');
}

apiServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const isWs =
    pathname === '/api/ws' ||
    pathname === '/ws' ||
    pathname === '/rde-ui/api/ws' ||
    pathname === '/rde-api/ws';
  if (isWs) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});
