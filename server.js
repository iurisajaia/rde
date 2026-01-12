const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// State management (same as main.js)
let currentTarget = null;
let rdeProcess = null;
let commandQueue = [];
let isExecutingCommand = false;
let commandOutputs = new Map();
let logStreams = new Map();
let commandCounter = 0;
let connectionResolve = null;
let welcomeBuffer = '';

// WebSocket server for real-time events
const wss = new WebSocket.Server({ noServer: true });

// Helper to emit events to all connected clients
function sendToClients(channel, data) {
  const message = JSON.stringify({ channel, data });
  let sentCount = 0;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        sentCount++;
      } catch (error) {
        console.error('[WebSocket] Error sending message:', error);
      }
    }
  });
  if (sentCount > 0) {
    console.log(`[WebSocket] Sent message to ${sentCount} client(s). Channel: ${channel}`);
  }
}

// Handle WebSocket connections
wss.on('connection', (ws, request) => {
  console.log('[WebSocket] New client connected from:', request.socket.remoteAddress);
  
  ws.on('message', (message) => {
    console.log('[WebSocket] Received message:', message.toString());
  });
  
  ws.on('close', (code, reason) => {
    console.log('[WebSocket] Client disconnected. Code:', code, 'Reason:', reason ? reason.toString() : 'none');
  });
  
  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
  });
  
  // Send a welcome message and current connection status
  try {
    ws.send(JSON.stringify({ 
      channel: 'connection', 
      data: { status: 'connected', message: 'WebSocket connection established' } 
    }));
    
    // If already connected to RDE, send status update
    if (currentTarget !== null && rdeProcess && rdeProcess.pid) {
      ws.send(JSON.stringify({
        channel: 'rde/status',
        data: {
          state: 'connected',
          message: 'Connected to RDE'
        }
      }));
    }
  } catch (error) {
    console.error('[WebSocket] Error sending welcome message:', error);
  }
});

/**
 * Find the rde executable path
 */
function findRdePath() {
  const commonPaths = [
    '/usr/local/bin/rde',
    '/usr/bin/rde',
    '/opt/homebrew/bin/rde',
    '/opt/local/bin/rde',
    path.join(process.env.HOME || '', '.local/bin/rde'),
    path.join(process.env.HOME || '', 'bin/rde'),
  ];

  for (const rdePath of commonPaths) {
    try {
      if (fs.existsSync(rdePath) && fs.statSync(rdePath).isFile()) {
        fs.accessSync(rdePath, fs.constants.X_OK);
        return rdePath;
      }
    } catch (e) {
      // Continue
    }
  }

  try {
    const whichPath = execSync('which rde', { encoding: 'utf8', timeout: 1000 }).trim();
    if (whichPath && fs.existsSync(whichPath)) {
      return whichPath;
    }
  } catch (e) {
    // Continue
  }

  return 'rde';
}

/**
 * Create and maintain persistent rde ssh session
 */
function createRDESession() {
  if (rdeProcess) {
    console.log('[RDE SESSION] Session already exists');
    return rdeProcess;
  }

  console.log('[RDE SESSION] Creating persistent rde ssh session...');
  const rdePath = findRdePath();
  console.log('[RDE SESSION] Using rde path:', rdePath);
  
  try {
    rdeProcess = spawn(rdePath, ['ssh'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin'
      }
    });
    
    console.log('[RDE SESSION] Process spawned, PID:', rdeProcess.pid);
  } catch (error) {
    console.error('[RDE SESSION] Failed to spawn process:', error);
    throw error;
  }

  commandOutputs.clear();
  welcomeBuffer = '';

  rdeProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[RDE SESSION] stdout data received:', text.substring(0, 100));
    welcomeBuffer += text;
    
    if (welcomeBuffer.length > 10000) {
      welcomeBuffer = welcomeBuffer.slice(-5000);
    }
    
    if (connectionResolve && welcomeBuffer.toLowerCase().includes('welcome')) {
      console.log('[RDE SESSION] Welcome message detected!');
      const resolve = connectionResolve;
      connectionResolve = null;
      welcomeBuffer = '';
      resolve();
    }
    
    const lines = text.split('\n');
    
    // Process each line
    lines.forEach((line, lineIndex) => {
      // Store output for current command
      if (rdeProcess._currentCommand) {
        const tracker = rdeProcess._currentCommand;
        if (!commandOutputs.has(tracker.id)) {
          commandOutputs.set(tracker.id, { stdout: [], stderr: [] });
        }
        const output = commandOutputs.get(tracker.id);
        // Store all non-empty lines (including lines that might look like prompts but aren't)
        if (line.trim()) {
          // Only skip if it's actually a prompt (ends with $ or # followed by whitespace)
          if (!isPrompt(line)) {
            output.stdout.push(line.trim());
            console.log('[STDOUT] Storing line for', tracker.id, ':', line.trim().substring(0, 100));
            
            // Update last output time for inactivity detection
            tracker.lastOutputTime = Date.now();
            
            // Send to WebSocket clients
            sendToClients('command/output', {
              id: tracker.id,
              source: 'stdout',
              text: line.trim()
            });
            
            // Early completion for supervisor status - wait for multiple lines before completing
            if (tracker.command && tracker.command.includes('supervisorctl status')) {
              if (!tracker._earlyCompleteScheduled) {
                tracker._earlyCompleteScheduled = true;
                console.log('[EARLY COMPLETE] Scheduling early completion for supervisor status, command:', tracker.command);
                // Wait longer to collect all output (supervisor status can be many lines)
                setTimeout(() => {
                  if (rdeProcess._currentCommand && rdeProcess._currentCommand.id === tracker.id) {
                    const output = commandOutputs.get(tracker.id);
                    const fullOutput = output ? output.stdout.join('\n') : '';
                    console.log('[EARLY COMPLETE] Supervisor status output length:', fullOutput.length);
                    console.log('[EARLY COMPLETE] Output preview:', fullOutput.substring(0, 500));
                    console.log('[EARLY COMPLETE] Output lines count:', output ? output.stdout.length : 0);
                    commandOutputs.delete(tracker.id);
                    isExecutingCommand = false;
                    rdeProcess._currentCommand = null;
                    if (tracker.timeout) clearTimeout(tracker.timeout);
                    tracker.resolve({ exitCode: 0, output: fullOutput });
                    processNextCommand();
                  } else {
                    console.log('[EARLY COMPLETE] Command already completed or changed');
                  }
                }, 2000); // Longer delay to collect all supervisor output
              }
            }
          } else {
            console.log('[STDOUT] Skipped prompt line:', line.trim());
          }
        }
      }
      
      // If we see a prompt, complete the current command immediately
      if (isPrompt(line) && rdeProcess._currentCommand) {
        const tracker = rdeProcess._currentCommand;
        const output = commandOutputs.get(tracker.id);
        const fullOutput = output ? output.stdout.join('\n') : '';
        console.log('[PROMPT COMPLETE] Command', tracker.id, 'completed. Output length:', fullOutput.length);
        commandOutputs.delete(tracker.id);
        isExecutingCommand = false;
        rdeProcess._currentCommand = null;
        if (tracker.timeout) clearTimeout(tracker.timeout);
        if (tracker.outputTimeout) clearTimeout(tracker.outputTimeout);
        tracker.resolve({ exitCode: 0, output: fullOutput });
        processNextCommand();
      }
    });
  });

  rdeProcess.stderr.on('data', (data) => {
    const text = data.toString();
    console.log('[RDE SESSION] stderr data received:', text.substring(0, 200));
    sendToClients('command/output', {
      id: 'rde-debug',
      source: 'stderr',
      text: text
    });
  });

  rdeProcess.on('exit', (code, signal) => {
    console.log('[RDE SESSION] Process exited with code:', code, 'signal:', signal);
    const oldProcess = rdeProcess;
    rdeProcess = null;
    currentTarget = null;
    
    // Reject any pending connection
    if (connectionResolve) {
      connectionResolve(new Error('RDE session closed before connection'));
      connectionResolve = null;
    }
    
    commandQueue.forEach(({ reject }) => {
      reject(new Error('RDE session closed'));
    });
    
    commandQueue = [];
    commandOutputs.clear();
    isExecutingCommand = false;
    if (oldProcess) {
      oldProcess._currentCommand = null;
    }
    
    sendToClients('rde/status', {
      state: 'disconnected',
      message: 'RDE session closed'
    });
  });

  rdeProcess.on('error', (error) => {
    console.error('[RDE SESSION] Process error:', error);
    console.error('[RDE SESSION] Error stack:', error.stack);
    const oldProcess = rdeProcess;
    rdeProcess = null;
    currentTarget = null;
    
    // Reject any pending connection
    if (connectionResolve) {
      connectionResolve(error);
      connectionResolve = null;
    }
    
    commandQueue.forEach(({ reject }) => {
      reject(error);
    });
    commandQueue = [];
    commandOutputs.clear();
    isExecutingCommand = false;
    if (oldProcess) {
      oldProcess._currentCommand = null;
    }
    
    sendToClients('rde/status', {
      state: 'error',
      message: error.message
    });
  });

  return rdeProcess;
}

function isPrompt(line) {
  return !!line.match(/[#$]\s*$/);
}

function generateCommandId() {
  return `cmd-${Date.now()}-${++commandCounter}`;
}

function executeInRDESession(command, commandId) {
  return new Promise((resolve, reject) => {
    if (!rdeProcess) {
      reject(new Error('RDE session not established'));
      return;
    }

    commandQueue.push({ command, commandId, resolve, reject });
    
    if (!isExecutingCommand) {
      processNextCommand();
    }
  });
}

function processNextCommand() {
  if (commandQueue.length === 0 || isExecutingCommand) {
    return;
  }

  const { command, commandId, resolve, reject } = commandQueue.shift();
  isExecutingCommand = true;
  
  commandOutputs.set(commandId, { stdout: [], stderr: [] });
  
  const commandTracker = {
    id: commandId,
    command: command,
    resolve: resolve,
    reject: reject,
    timeout: null,
    outputTimeout: null,
    lastOutputTime: Date.now(),
    _earlyCompleteScheduled: false
  };
  
  // Function to complete command
  const completeCommand = () => {
    if (commandTracker.resolve && rdeProcess._currentCommand === commandTracker) {
      const output = commandOutputs.get(commandId);
      const fullOutput = output ? output.stdout.join('\n') : '';
      commandOutputs.delete(commandId);
      isExecutingCommand = false;
      rdeProcess._currentCommand = null;
      if (commandTracker.timeout) clearTimeout(commandTracker.timeout);
      if (commandTracker.outputTimeout) clearTimeout(commandTracker.outputTimeout);
      commandTracker.resolve({ exitCode: 0, output: fullOutput });
      processNextCommand();
    }
  };
  
  // Check for output inactivity - if no output for 1 second, complete the command
  const checkOutputActivity = () => {
    if (commandTracker.resolve && rdeProcess._currentCommand === commandTracker) {
      const timeSinceLastOutput = Date.now() - commandTracker.lastOutputTime;
      // If no output for 1 second and we have some output, complete the command
      if (timeSinceLastOutput >= 1000) {
        const output = commandOutputs.get(commandId);
        if (output && output.stdout.length > 0) {
          console.log('[OUTPUT TIMEOUT] Command', commandId, 'completed due to output inactivity');
          completeCommand();
          return;
        }
      }
      // Check again in 200ms
      commandTracker.outputTimeout = setTimeout(checkOutputActivity, 200);
    }
  };
  
  // Start checking for output inactivity
  checkOutputActivity();
  
  // Fallback timeout - reduced from 30s to 5s
  commandTracker.timeout = setTimeout(() => {
    if (commandTracker.resolve && rdeProcess._currentCommand === commandTracker) {
      console.log('[TIMEOUT] Command', commandId, 'completed due to timeout');
      completeCommand();
    }
  }, 5000);
  
  rdeProcess._currentCommand = commandTracker;
  rdeProcess.stdin.write(command + '\n');
}

function executeRemoteCommand(target, command, commandId) {
  const promise = executeInRDESession(command, commandId);
  return {
    process: rdeProcess,
    promise: promise
  };
}

function closeRDESession() {
  if (rdeProcess) {
    rdeProcess.stdin.end();
    rdeProcess.kill();
    rdeProcess = null;
  }
  commandQueue = [];
  isExecutingCommand = false;
  currentTarget = null;
  welcomeBuffer = '';
  connectionResolve = null;
}

// API Routes

// Get current connection status
app.get('/api/rde/status', (req, res) => {
  const isConnected = currentTarget !== null && rdeProcess !== null && rdeProcess.pid;
  res.json({
    connected: isConnected,
    target: currentTarget || '',
    pid: rdeProcess?.pid || null
  });
});

app.post('/api/rde/connect', async (req, res) => {
  console.log('[CONNECT] Starting connection process...');
  
  try {
    // Check if already connected
    if (currentTarget !== null && rdeProcess) {
      console.log('[CONNECT] Already connected');
      return res.json({ success: true, message: 'Already connected' });
    }
    
    // Create RDE session
    console.log('[CONNECT] Creating RDE session...');
    createRDESession();
    
    if (!rdeProcess) {
      throw new Error('Failed to create RDE session');
    }
    
    console.log('[CONNECT] Waiting for Welcome message...');
    
    const welcomePromise = new Promise((resolve, reject) => {
      connectionResolve = resolve;
      welcomeBuffer = ''; // Reset buffer
      
      // Timeout after 15 seconds
      const timeoutId = setTimeout(() => {
        if (connectionResolve === resolve) {
          console.log('[CONNECT] Timeout! Buffer content (last 500 chars):', welcomeBuffer.slice(-500));
          connectionResolve = null;
          welcomeBuffer = '';
          reject(new Error('Connection timeout: Welcome message not received. Buffer: ' + welcomeBuffer.slice(-200)));
        }
      }, 15000);
      
      // Store timeout ID for cleanup
      if (connectionResolve) {
        connectionResolve._timeoutId = timeoutId;
      }
    });
    
    try {
      await welcomePromise;
      
      console.log('[CONNECT] Welcome message received - connection successful!');
      currentTarget = '';
      sendToClients('rde/status', {
        state: 'connected',
        message: 'Connected to RDE'
      });
      res.json({ success: true });
    } catch (error) {
      console.error('[CONNECT] Welcome promise failed:', error.message);
      connectionResolve = null;
      if (rdeProcess) {
        closeRDESession();
      }
      throw error;
    }
  } catch (error) {
    console.error('[CONNECT] Connection error:', error);
    console.error('[CONNECT] Stack:', error.stack);
    connectionResolve = null;
    sendToClients('rde/status', {
      state: 'error',
      message: error.message
    });
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/rde/disconnect', async (req, res) => {
  closeRDESession();
  sendToClients('rde/status', {
    state: 'disconnected',
    message: 'Disconnected'
  });
  res.json({ success: true });
});

app.get('/api/supervisor/status', async (req, res) => {
  if (currentTarget === null) {
    console.log('[SUPERVISOR STATUS] Not connected');
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const commandId = generateCommandId();
  const command = 'sudo supervisorctl status all';
  
  try {
    console.log('[SUPERVISOR STATUS] Executing command:', command, 'ID:', commandId);
    const { promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    console.log('[SUPERVISOR STATUS] Command completed. Exit code:', result.exitCode);
    console.log('[SUPERVISOR STATUS] Output length:', result.output ? result.output.length : 0);
    console.log('[SUPERVISOR STATUS] Output preview:', result.output ? result.output.substring(0, 200) : 'null');
    
    // Parse supervisor status output
    // Format: serviceName RUNNING pid 12345, uptime 0:00:01
    const services = [];
    const output = result.output || '';
    const lines = output.trim().split('\n');
    
    console.log('[SUPERVISOR STATUS] Total lines:', lines.length);
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      // Parse line: "serviceName RUNNING pid 12345, uptime 0:00:01"
      // Handle lines like "api-group:api    RUNNING   pid 29191, uptime 12 days, 23:46:34"
      const trimmedLine = line.trim();
      const match = trimmedLine.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
      
      if (match) {
        const name = match[1];
        const state = match[2];
        const extra = match[3] || '';
        
        services.push({ name, state, extra });
        console.log('[SUPERVISOR STATUS] Parsed service:', name, state);
      } else {
        // Fallback: split by whitespace
        const parts = trimmedLine.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[0];
          const state = parts[1];
          const extra = parts.slice(2).join(' ');
          
          services.push({ name, state, extra });
          console.log('[SUPERVISOR STATUS] Parsed service (fallback):', name, state);
        } else {
          console.log('[SUPERVISOR STATUS] Skipped line (no match):', trimmedLine);
        }
      }
    }
    
    console.log('[SUPERVISOR STATUS] Total parsed services:', services.length);
    
    sendToClients('supervisor/statusResult', { services });
    res.json({ success: true, services });
  } catch (error) {
    console.error('[SUPERVISOR STATUS] Error:', error);
    console.error('[SUPERVISOR STATUS] Stack:', error.stack);
    sendToClients('supervisor/statusResult', { services: [] });
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/supervisor/restart', async (req, res) => {
  const { serviceName } = req.body;
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const commandId = generateCommandId();
  try {
    const { promise } = executeRemoteCommand('', `sudo supervisorctl restart ${serviceName}`, commandId);
    const result = await promise;
    
    // Parse output to get new state
    const lines = result.output.split('\n');
    const statusLine = lines.find(l => l.includes(serviceName));
    const newState = statusLine ? statusLine.split(/\s+/)[1] : 'UNKNOWN';
    
    res.json({ success: true, serviceName, newState, output: result.output });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/supervisor/start', async (req, res) => {
  const { serviceName } = req.body;
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const commandId = generateCommandId();
  try {
    const { promise } = executeRemoteCommand('', `sudo supervisorctl start ${serviceName}`, commandId);
    const result = await promise;
    const lines = result.output.split('\n');
    const statusLine = lines.find(l => l.includes(serviceName));
    const newState = statusLine ? statusLine.split(/\s+/)[1] : 'UNKNOWN';
    res.json({ success: true, serviceName, newState, output: result.output });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/supervisor/stop', async (req, res) => {
  const { serviceName } = req.body;
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const commandId = generateCommandId();
  try {
    const { promise } = executeRemoteCommand('', `sudo supervisorctl stop ${serviceName}`, commandId);
    const result = await promise;
    const lines = result.output.split('\n');
    const statusLine = lines.find(l => l.includes(serviceName));
    const newState = statusLine ? statusLine.split(/\s+/)[1] : 'UNKNOWN';
    res.json({ success: true, serviceName, newState, output: result.output });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/supervisor/bulk', async (req, res) => {
  const { serviceNames, operation } = req.body;
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const results = [];
  for (const serviceName of serviceNames) {
    const commandId = generateCommandId();
    try {
      const { promise } = executeRemoteCommand('', `sudo supervisorctl ${operation} ${serviceName}`, commandId);
      const result = await promise;
      const lines = result.output.split('\n');
      const statusLine = lines.find(l => l.includes(serviceName));
      const newState = statusLine ? statusLine.split(/\s+/)[1] : 'UNKNOWN';
      results.push({ serviceName, success: true, newState, output: result.output });
    } catch (error) {
      results.push({ serviceName, success: false, error: error.message });
    }
  }
  
  res.json({ success: true, results });
});

app.get('/api/logs/list', async (req, res) => {
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  // Hardcoded list of log files for speed (no need to query)
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
    '/opt/fundbox/logs/mobile_app.log',
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

app.post('/api/logs/tail', async (req, res) => {
  const { files, mode, lines } = req.body;
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const streamId = `stream-${Date.now()}`;
  let command = '';
  
  if (mode === 'last') {
    const linesCount = lines || 200;
    if (files.length === 1) {
      command = `tail -n ${linesCount} ${files[0]}`;
    } else {
      command = `tail -n ${linesCount} ${files.join(' ')}`;
    }
  } else if (mode === 'follow') {
    if (files.length === 1) {
      command = `tail -f ${files[0]}`;
    } else {
      command = `tail -f ${files.join(' ')}`;
    }
  }
  
  const rdePath = findRdePath();
  const childProcess = spawn(rdePath, ['ssh'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin'
    }
  });
  
  childProcess.stdin.write(command + '\n');
  childProcess.stdin.end();
  
  let currentFileIndex = 0;
  childProcess.stdout.on('data', (data) => {
    const text = data.toString();
    const fileLines = text.split('\n').filter(l => l.trim());
    fileLines.forEach(line => {
      sendToClients('logs/line', {
        streamId,
        file: files[currentFileIndex % files.length] || files[0],
        line: line
      });
    });
  });
  
  childProcess.on('exit', () => {
    sendToClients('logs/stopped', {
      streamId,
      reason: 'completed',
      message: 'Stream completed'
    });
    logStreams.delete(streamId);
  });
  
  logStreams.set(streamId, { process: childProcess, files, mode, active: true });
  res.json({ success: true, streamId });
});

app.post('/api/logs/stop', async (req, res) => {
  const { streamId } = req.body;
  const stream = logStreams.get(streamId);
  if (stream) {
    stream.process.kill();
    logStreams.delete(streamId);
    sendToClients('logs/stopped', {
      streamId,
      reason: 'stopped',
      message: 'Stream stopped by user'
    });
  }
  res.json({ success: true });
});

app.post('/api/command/execute', async (req, res) => {
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const { command } = req.body;
  const commandId = generateCommandId();
  
  try {
    const { promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    res.json({ 
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      output: result.output || '',
      commandId
    });
  } catch (error) {
    res.json({ success: false, error: error.message, commandId });
  }
});

// Git info endpoint
app.get('/api/git/info', async (req, res) => {
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  try {
    // Get current branch
    const branchCmd = 'cd /opt/fundbox/backend && git rev-parse --abbrev-ref HEAD';
    const branchCommandId = generateCommandId();
    const { promise: branchPromise } = executeRemoteCommand('', branchCmd, branchCommandId);
    const branchResult = await branchPromise;
    
    if (branchResult.exitCode !== 0) {
      return res.json({ success: false, error: `Failed to get git branch: ${branchResult.output || 'Unknown error'}` });
    }
    
    const branch = branchResult.output.trim();
    
    // Get git status (short format)
    const statusCmd = 'cd /opt/fundbox/backend && git status --short';
    const statusCommandId = generateCommandId();
    const { promise: statusPromise } = executeRemoteCommand('', statusCmd, statusCommandId);
    const statusResult = await statusPromise;
    
    const changes = statusResult.exitCode === 0 
      ? statusResult.output.trim().split('\n').filter(l => l.trim()).map(line => {
          // Parse git status line: " M file.py" or "?? newfile.py" or "M  file.py"
          // Format: XY filename (X = staged, Y = unstaged)
          const trimmed = line.trim();
          if (trimmed.length < 3) {
            return { status: '', file: trimmed };
          }
          const status = trimmed.substring(0, 2);
          const file = trimmed.substring(3).trim();
          return { status, file };
        })
      : [];
    
    res.json({
      success: true,
      branch: branch,
      changes: changes,
      hasChanges: changes.length > 0
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Git diff endpoint for a specific file
app.post('/api/git/diff', async (req, res) => {
  if (currentTarget === null) {
    return res.json({ success: false, error: 'Not connected' });
  }
  
  const { file } = req.body;
  if (!file) {
    return res.json({ success: false, error: 'File path required' });
  }
  
  try {
    // Get diff for the file
    const diffCmd = `cd /opt/fundbox/backend && git diff ${file}`;
    const commandId = generateCommandId();
    const { promise } = executeRemoteCommand('', diffCmd, commandId);
    const result = await promise;
    
    res.json({
      success: result.exitCode === 0,
      diff: result.output || '',
      file: file
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Upgrade HTTP server to handle WebSocket
const server = app.listen(PORT, () => {
  console.log(`🚀 RDE Control Center API server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  console.log('[WebSocket] Upgrade request for path:', pathname);
  
  // Handle WebSocket connections at /api/ws
  if (pathname === '/api/ws' || pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws, request) => {
      console.log('[WebSocket] Upgrade successful, emitting connection event');
      wss.emit('connection', ws, request);
    });
  } else {
    console.log('[WebSocket] Rejecting upgrade for path:', pathname);
    socket.destroy();
  }
});

