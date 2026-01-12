const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// State management
let currentTarget = null; // null = disconnected, '' = connected (no target needed for rde ssh)
let rdeProcess = null; // Persistent rde ssh process
let commandQueue = []; // Queue for commands
let isExecutingCommand = false;
let commandOutputs = new Map(); // commandId -> { stdout: [], stderr: [] }
let logStreams = new Map(); // streamId -> { process, files, mode, active }
let commandCounter = 0;
let connectionResolve = null; // Promise resolver for connection success detection
let welcomeBuffer = ''; // Accumulated output for Welcome detection

/**
 * Find the rde executable path
 * Electron doesn't inherit the same PATH as the terminal
 */
function findRdePath() {
  // Common locations where rde might be installed
  const commonPaths = [
    '/usr/local/bin/rde',
    '/usr/bin/rde',
    '/opt/homebrew/bin/rde',
    '/opt/local/bin/rde',
    path.join(process.env.HOME || '', '.local/bin/rde'),
    path.join(process.env.HOME || '', 'bin/rde'),
  ];

  // Check if rde exists in common paths
  for (const rdePath of commonPaths) {
    try {
      if (fs.existsSync(rdePath) && fs.statSync(rdePath).isFile()) {
        // Check if it's executable
        fs.accessSync(rdePath, fs.constants.X_OK);
        return rdePath;
      }
    } catch (e) {
      // Continue to next path
    }
  }

  // Try to find it using which command (if available)
  try {
    const whichPath = execSync('which rde', { encoding: 'utf8', timeout: 1000 }).trim();
    if (whichPath && fs.existsSync(whichPath)) {
      return whichPath;
    }
  } catch (e) {
    // which command failed, continue
  }

  // Fallback: try to use rde from PATH with extended PATH
  return 'rde';
}

/**
 * Send IPC event to renderer if window exists
 */
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/**
 * Create and maintain persistent rde ssh session
 */
function createRDESession() {
  if (rdeProcess) {
    return rdeProcess; // Already exists
  }

  console.log('Creating persistent rde ssh session...');
  sendToRenderer('command/output', {
    id: 'rde-debug',
    source: 'stdout',
    text: '[RDE SESSION] Creating persistent rde ssh session...'
  });
  const rdePath = findRdePath();
  rdeProcess = spawn(rdePath, ['ssh'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin'
    }
  });

  // Clear any existing command outputs
  commandOutputs.clear();
  
  // Reset welcome buffer
  welcomeBuffer = '';

  // Handle stdout - parse output and detect command completion
  rdeProcess.stdout.on('data', (data) => {
    const text = data.toString();
    
    // Accumulate output for Welcome detection (in case Welcome spans multiple data chunks)
    welcomeBuffer += text;
    
    // Check for "Welcome" message in accumulated buffer (case-insensitive)
    // Limit buffer size to avoid memory issues
    if (welcomeBuffer.length > 10000) {
      welcomeBuffer = welcomeBuffer.slice(-5000); // Keep last 5KB
    }
    
    if (connectionResolve && welcomeBuffer.toLowerCase().includes('welcome')) {
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stdout',
        text: `[CONNECTION] Welcome message detected in buffer (length: ${welcomeBuffer.length}) - login successful!`
      });
      const resolve = connectionResolve;
      connectionResolve = null;
      welcomeBuffer = ''; // Clear buffer after successful connection
      resolve();
    }
    
    // Send raw output for debugging (show exactly what we receive, including empty lines)
    // Show the raw bytes with escaped special characters
    const rawDebugText = text
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    
    // Send raw chunk (may contain multiple lines)
    sendToRenderer('command/output', {
      id: 'rde-debug',
      source: 'stdout',
      text: `[RAW STDOUT] ${JSON.stringify(text)} (length: ${text.length})`
    });
    
    const lines = text.split('\n');
    
    // Process each line
    lines.forEach((line, lineIndex) => {
      
      // Always show each line for debugging
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stdout',
        text: `[LINE ${lineIndex}] "${line}" | trimmed: "${line.trim()}" | isPrompt: ${!!line.match(/[#$]\s*$/)}`
      });
      
      // Check if this looks like a prompt (command finished)
      const isPrompt = line.match(/[#$]\s*$/);
      
      // Send output to all active commands
      commandOutputs.forEach((output, cmdId) => {
        if (line.trim() && !isPrompt) {
          output.stdout.push(line.trim());
          sendToRenderer('command/output', {
            id: cmdId,
            source: 'stdout',
            text: line.trim()
          });
          
          // Early completion for supervisor status - complete as soon as we get any output
          if (rdeProcess._currentCommand && 
              rdeProcess._currentCommand.id === cmdId &&
              rdeProcess._currentCommand.command &&
              rdeProcess._currentCommand.command.includes('supervisorctl status')) {
            // Wait a bit to collect more output, then complete
            if (!rdeProcess._currentCommand._earlyCompleteScheduled) {
              rdeProcess._currentCommand._earlyCompleteScheduled = true;
              setTimeout(() => {
                if (rdeProcess._currentCommand && rdeProcess._currentCommand.id === cmdId) {
                  const tracker = rdeProcess._currentCommand;
                  const output = commandOutputs.get(cmdId);
                  const fullOutput = output ? output.stdout.join('\n') : '';
                  commandOutputs.delete(cmdId);
                  rdeProcess._currentCommand = null;
                  isExecutingCommand = false;
                  
                  if (tracker.resolve) {
                    tracker.resolve({ exitCode: 0, output: fullOutput });
                  }
                  processNextCommand();
                }
              }, 300); // Small delay to collect remaining output
            }
          }
        }
      });
      
      // If we see a prompt, complete the current command
      if (isPrompt && rdeProcess._currentCommand) {
        sendToRenderer('command/output', {
          id: 'rde-debug',
          source: 'stdout',
          text: `[PROMPT DETECTED] Completing command: ${rdeProcess._currentCommand.id}`
        });
        const tracker = rdeProcess._currentCommand;
        if (tracker.timeout) {
          clearTimeout(tracker.timeout);
        }
        const output = commandOutputs.get(tracker.id);
        const fullOutput = output ? output.stdout.join('\n') : '';
        commandOutputs.delete(tracker.id);
        rdeProcess._currentCommand = null;
        isExecutingCommand = false;
        
        if (tracker.resolve) {
          tracker.resolve({ exitCode: 0, output: fullOutput });
        }
        processNextCommand();
      }
    });
  });

  // Handle stderr
  rdeProcess.stderr.on('data', (data) => {
    const errorText = data.toString();
    console.error('RDE stderr:', errorText);
    
    // Send raw stderr for debugging
    sendToRenderer('command/output', {
      id: 'rde-debug',
      source: 'stderr',
      text: `[RAW STDERR] ${JSON.stringify(errorText)} (length: ${errorText.length})`
    });
    
    const trimmedError = errorText.trim();
    
    // Send to all active commands
    commandOutputs.forEach((output, cmdId) => {
      if (trimmedError) {
        output.stderr.push(trimmedError);
        sendToRenderer('command/output', {
          id: cmdId,
          source: 'stderr',
          text: trimmedError
        });
      }
    });
  });

  // Handle process exit
  rdeProcess.on('exit', (code) => {
    console.log('RDE session closed with code:', code);
    const oldProcess = rdeProcess;
    rdeProcess = null;
    currentTarget = null;
    
    // Reject any pending commands
    commandQueue.forEach(({ reject }) => {
      reject(new Error('RDE session closed'));
    });
    
    // Clear queue and outputs
    commandQueue = [];
    commandOutputs.clear();
    isExecutingCommand = false;
    if (oldProcess) {
      oldProcess._currentCommand = null;
    }
    
    sendToRenderer('rde/status', {
      state: 'disconnected',
      message: 'RDE session closed'
    });
  });

  rdeProcess.on('error', (error) => {
    console.error('RDE process error:', error);
    const oldProcess = rdeProcess;
    rdeProcess = null;
    currentTarget = null;
    
    // Reject all pending commands
    commandQueue.forEach(({ reject }) => {
      reject(error);
    });
    commandQueue = [];
    commandOutputs.clear();
    isExecutingCommand = false;
    if (oldProcess) {
      oldProcess._currentCommand = null;
    }
    
    sendToRenderer('rde/status', {
      state: 'error',
      message: error.message
    });
  });

  return rdeProcess;
}

/**
 * Execute command in persistent RDE session
 */
function executeInRDESession(command, commandId) {
  return new Promise((resolve, reject) => {
    if (!rdeProcess) {
      reject(new Error('RDE session not established'));
      return;
    }

    // Add to queue
    commandQueue.push({ command, commandId, resolve, reject });
    
    // Process queue if not already executing
    if (!isExecutingCommand) {
      processNextCommand();
    }
  });
}

/**
 * Process next command in queue
 */
function processNextCommand() {
  if (commandQueue.length === 0 || isExecutingCommand) {
    return;
  }

  const { command, commandId, resolve, reject } = commandQueue.shift();
  isExecutingCommand = true;
  
  // Debug: Log command execution start
  sendToRenderer('command/output', {
    id: 'rde-debug',
    source: 'stdout',
    text: `[CMD START] ID: ${commandId}, Command: "${command}"`
  });
  
  // Initialize output collector for this command
  commandOutputs.set(commandId, { stdout: [], stderr: [] });
  
  // Set up command tracking
  const commandTracker = {
    id: commandId,
    command: command, // Store command for early completion detection
    resolve: resolve,
    reject: reject,
    timeout: null,
    _earlyCompleteScheduled: false
  };
  
  // Set timeout as fallback (adjust timeout as needed)
  commandTracker.timeout = setTimeout(() => {
    if (commandTracker.resolve && rdeProcess._currentCommand === commandTracker) {
      console.warn('Command timeout, assuming completion:', command);
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stderr',
        text: `[CMD TIMEOUT] ID: ${commandId}, Command: "${command}", Output length: ${commandOutputs.get(commandId)?.stdout.length || 0}`
      });
      const output = commandOutputs.get(commandId);
      const fullOutput = output ? output.stdout.join('\n') : '';
      commandOutputs.delete(commandId);
      isExecutingCommand = false;
      rdeProcess._currentCommand = null;
      commandTracker.resolve({ exitCode: 0, output: fullOutput });
      processNextCommand();
    }
  }, 30000); // 30 second timeout

  // Store tracker for stdout handler to access
  rdeProcess._currentCommand = commandTracker;
  
  // Send command to RDE session via stdin
  // Add newline to execute the command
  sendToRenderer('command/output', {
    id: 'rde-debug',
    source: 'stdout',
    text: `[CMD SEND] Writing to stdin: "${command}\\n"`
  });
  rdeProcess.stdin.write(command + '\n');
}

/**
 * Execute a remote command via persistent RDE session
 * @param {string} target - Target host (not used, kept for compatibility)
 * @param {string} command - Command to execute
 * @param {string} commandId - Unique command ID for tracking
 * @param {Object} options - Options for command execution
 * @returns {Promise<Object>} Process and promise
 */
function executeRemoteCommand(target, command, commandId, options = {}) {
  // Execute in persistent RDE session
  const promise = executeInRDESession(command, commandId);
  
  return {
    process: rdeProcess, // Return the persistent process
    promise: promise
  };
}

/**
 * Close RDE session
 */
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

/**
 * Generate a unique command ID
 */
function generateCommandId() {
  return `cmd-${Date.now()}-${++commandCounter}`;
}

/**
 * Generate a unique stream ID
 */
function generateStreamId() {
  return `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

let mainWindow;

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load the renderer (React app)
  if (isDev) {
    // Development: load from Vite dev server
    mainWindow.loadURL('http://localhost:5173');
    // DevTools can be opened manually with Cmd+Option+I (Mac) or Ctrl+Shift+I (Windows/Linux)
  } else {
    // Production: load from built files
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Kill all active log streams before quitting
  logStreams.forEach((stream, streamId) => {
    if (stream.active && stream.process) {
      stream.process.kill();
    }
  });
  logStreams.clear();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================================================
// IPC Handlers - Renderer → Main
// ============================================================================

/**
 * rde/connect
 * Connect to a target host (target is optional - if empty, just connects to default rde)
 * Actually runs rde ssh to verify connection works
 */
ipcMain.handle('rde/connect', async (event, { target }) => {
  try {
    sendToRenderer('command/output', {
      id: 'rde-debug',
      source: 'stdout',
      text: '[CONNECT] Starting connection process...'
    });
    
    // Create persistent rde ssh session
    createRDESession();
    
    // Wait for "Welcome" message to detect successful login
    sendToRenderer('command/output', {
      id: 'rde-debug',
      source: 'stdout',
      text: '[CONNECT] Waiting for Welcome message...'
    });
    
    const welcomePromise = new Promise((resolve, reject) => {
      connectionResolve = resolve;
      welcomeBuffer = ''; // Reset buffer
      // Timeout after 15 seconds if we don't see Welcome
      setTimeout(() => {
        if (connectionResolve === resolve) {
          sendToRenderer('command/output', {
            id: 'rde-debug',
            source: 'stderr',
            text: `[CONNECT] Timeout! Buffer content (last 500 chars): ${welcomeBuffer.slice(-500)}`
          });
          connectionResolve = null;
          welcomeBuffer = '';
          reject(new Error('Connection timeout: Welcome message not received'));
        }
      }, 15000);
    });
    
    try {
      await welcomePromise;
      
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stdout',
        text: '[CONNECT] Welcome message received - connection successful!'
      });
      
      // Connection successful
      currentTarget = '';
      sendToRenderer('rde/status', {
        state: 'connected',
        message: 'Connected to RDE'
      });
      return { success: true };
    } catch (error) {
      connectionResolve = null;
      closeRDESession();
      throw error;
    }
  } catch (error) {
    console.error('Connection error:', error);
    connectionResolve = null;
    sendToRenderer('rde/status', {
      state: 'error',
      message: error.message
    });
    return { success: false, error: error.message };
  }
});

/**
 * rde/disconnect
 * Disconnect from current target
 */
ipcMain.handle('rde/disconnect', async (event, {}) => {
  try {
    // Stop all active log streams
    logStreams.forEach((stream, streamId) => {
      if (stream.active && stream.process) {
        stream.process.kill();
        sendToRenderer('logs/stopped', {
          streamId,
          reason: 'disconnected',
          message: 'Stream stopped due to disconnect'
        });
      }
    });
    logStreams.clear();

    // Close RDE session
    closeRDESession();
    
    sendToRenderer('rde/status', {
      state: 'disconnected',
      message: 'Disconnected'
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * supervisor/status
 * Get supervisor service status
 * Completes as soon as we get any output (don't wait for prompt)
 */
ipcMain.handle('supervisor/status', async (event, { target }) => {
  // Only allow if connected
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  const commandId = generateCommandId();
  const command = 'sudo supervisorctl status all';
  
  try {
    // Execute in persistent RDE session
    // Early completion is handled in stdout handler when it detects supervisor status output
    console.log('Executing command:', command);
    const { promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    console.log('Command exit code:', result.exitCode);
    console.log('Output length:', result.output ? result.output.length : 0);

    // Parse supervisor status output
    // Format: serviceName RUNNING pid 12345, uptime 0:00:01
    const services = [];
    const output = result.output || '';
    const lines = output.trim().split('\n');
    
    console.log('Total lines:', lines.length);
    
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
      } else {
        // Fallback: split by whitespace
        const parts = trimmedLine.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[0];
          const state = parts[1];
          const extra = parts.slice(2).join(' ');
          
          services.push({ name, state, extra });
        }
      }
    }

    console.log('Parsed services:', services.length);
    
    // Send full output to logs for debugging
    sendToRenderer('command/output', {
      id: commandId,
      source: 'stdout',
      text: `[SUPERVISOR STATUS RESULT]\n${output}\n[Parsed ${services.length} services]`
    });
    
    sendToRenderer('supervisor/statusResult', { services });
    return { success: true, services };
  } catch (error) {
    console.error('Error in supervisor/status:', error);
    sendToRenderer('supervisor/statusResult', { services: [] });
    return { success: false, error: error.message };
  }
});

/**
 * supervisor/restart
 * Restart a supervisor service
 */
ipcMain.handle('supervisor/restart', async (event, { target, serviceName }) => {
  // Only allow if connected
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  const commandId = generateCommandId();
  const command = `sudo supervisorctl restart ${serviceName}`;
  
  try {
    const { process, promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    // Parse output to check if restart was successful
    // Expected format: "serviceName: stopped" then "serviceName: started"
    const output = result.output || '';
    const lines = output.trim().split('\n');
    
    let restartSuccess = false;
    let newState = null;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      // Check if this line matches the service name and contains a state
      // Format: "backend-group:fetching: stopped" then "backend-group:fetching: started"
      if (trimmedLine.includes(serviceName) && trimmedLine.includes(':')) {
        // Extract state after the last colon (handles both "service: state" and "group:service: state")
        const parts = trimmedLine.split(':');
        const lastPart = parts[parts.length - 1].trim().toLowerCase();
        
        // Check if we see "started" which indicates success
        // Supervisor restart output shows "started" but status shows "RUNNING"
        if (lastPart === 'started') {
          restartSuccess = true;
          // Map "started" to "RUNNING" to match supervisorctl status output format
          newState = 'RUNNING';
          break;
        }
        // If we see "stopped", continue to look for "started" on next line
      }
    }
    
    return { 
      success: restartSuccess && result.exitCode === 0,
      serviceName: restartSuccess ? serviceName : undefined,
      newState: newState || (restartSuccess ? 'STARTED' : undefined),
      output: output
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * supervisor/start
 * Start a supervisor service
 */
ipcMain.handle('supervisor/start', async (event, { target, serviceName }) => {
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  const commandId = generateCommandId();
  const command = `sudo supervisorctl start ${serviceName}`;
  
  try {
    const { process, promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    const output = result.output || '';
    const lines = output.trim().split('\n');
    
    let startSuccess = false;
    let newState = null;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.includes(serviceName) && trimmedLine.includes(':')) {
        const parts = trimmedLine.split(':');
        const lastPart = parts[parts.length - 1].trim().toLowerCase();
        if (lastPart === 'started') {
          startSuccess = true;
          newState = 'RUNNING';
          break;
        }
      }
    }
    
    return { 
      success: startSuccess && result.exitCode === 0,
      serviceName: startSuccess ? serviceName : undefined,
      newState: newState || (startSuccess ? 'RUNNING' : undefined),
      output: output
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * supervisor/stop
 * Stop a supervisor service
 */
ipcMain.handle('supervisor/stop', async (event, { target, serviceName }) => {
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  const commandId = generateCommandId();
  const command = `sudo supervisorctl stop ${serviceName}`;
  
  try {
    const { process, promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    const output = result.output || '';
    const lines = output.trim().split('\n');
    
    let stopSuccess = false;
    let newState = null;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.includes(serviceName) && trimmedLine.includes(':')) {
        const parts = trimmedLine.split(':');
        const lastPart = parts[parts.length - 1].trim().toLowerCase();
        if (lastPart === 'stopped') {
          stopSuccess = true;
          newState = 'STOPPED';
          break;
        }
      }
    }
    
    return { 
      success: stopSuccess && result.exitCode === 0,
      serviceName: stopSuccess ? serviceName : undefined,
      newState: newState || (stopSuccess ? 'STOPPED' : undefined),
      output: output
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * supervisor/bulk
 * Execute bulk operations on multiple services
 */
ipcMain.handle('supervisor/bulk', async (event, { target, serviceNames, operation }) => {
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  if (!['start', 'stop', 'restart'].includes(operation)) {
    return { success: false, error: `Invalid operation: ${operation}` };
  }
  
  const results = [];
  
  for (const serviceName of serviceNames) {
    const commandId = generateCommandId();
    const command = `sudo supervisorctl ${operation} ${serviceName}`;
    
    try {
      const { process, promise } = executeRemoteCommand('', command, commandId);
      const result = await promise;
      
      const output = result.output || '';
      const lines = output.trim().split('\n');
      
      let success = false;
      let newState = null;
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.includes(serviceName) && trimmedLine.includes(':')) {
          const parts = trimmedLine.split(':');
          const lastPart = parts[parts.length - 1].trim().toLowerCase();
          if (operation === 'restart' && lastPart === 'started') {
            success = true;
            newState = 'RUNNING';
            break;
          } else if (operation === 'start' && lastPart === 'started') {
            success = true;
            newState = 'RUNNING';
            break;
          } else if (operation === 'stop' && lastPart === 'stopped') {
            success = true;
            newState = 'STOPPED';
            break;
          }
        }
      }
      
      results.push({
        serviceName,
        success: success && result.exitCode === 0,
        newState: newState || (success ? (operation === 'stop' ? 'STOPPED' : 'RUNNING') : undefined),
        output: output
      });
    } catch (error) {
      results.push({
        serviceName,
        success: false,
        error: error.message
      });
    }
  }
  
  return { success: true, results };
});

/**
 * logs/list
 * List available log files from /opt/fundbox/logs
 * Uses hardcoded list for speed
 */
ipcMain.handle('logs/list', async (event, { target }) => {
  // Only allow if connected
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
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

  return { success: true, files };
});

/**
 * logs/tail
 * Tail log files (last N lines or follow)
 */
ipcMain.handle('logs/tail', async (event, { target, files, mode, lines }) => {
  // Only allow if connected
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  const streamId = generateStreamId();
  
  try {
    let command;
    
    if (mode === 'last') {
      // Tail last N lines for each file
      const n = lines || 200;
      if (files.length === 1) {
        command = `tail -n ${n} ${files[0]}`;
      } else {
        const tailCommands = files.map(file => `tail -n ${n} ${file}`).join(' && ');
        command = `(${tailCommands})`;
      }
    } else if (mode === 'follow') {
      // Follow log files using tail -f
      // If many files selected (likely "All"), use glob pattern for better performance
      // tail -f with glob pattern is more efficient than listing all files
      if (files.length >= 10) {
        // Use glob pattern to tail all logs (more efficient)
        command = `tail -f /opt/fundbox/logs/*.log`;
      } else if (files.length === 1) {
        command = `tail -f ${files[0]}`;
      } else {
        // For multiple specific files, tail supports multiple files natively
        const filesList = files.join(' ');
        command = `tail -f ${filesList}`;
      }
    } else {
      return { success: false, error: `Invalid mode: ${mode}` };
    }

    // For follow mode, we need a separate rde ssh process since it's long-running
    // rde ssh doesn't accept commands as arguments - we need to pipe via stdin
    const rdePath = findRdePath();
    const childProcess = spawn(rdePath, ['ssh'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin'
      }
    });
    
    // Send the command to rde ssh via stdin, then close stdin so it executes
    childProcess.stdin.write(command + '\n');
    childProcess.stdin.end();
    
    sendToRenderer('command/output', {
      id: 'rde-debug',
      source: 'stdout',
      text: `[LOGS TAIL] Starting tail for ${files.length} file(s): ${command}`
    });

    let buffer = '';
    // Map to track which file each line belongs to
    // tail -F with multiple files outputs: "==> /path/to/file <==" before lines from that file
    let currentFile = files[0]; // Default to first file

    // Handle stdout (log lines)
    childProcess.stdout.on('data', (data) => {
      const text = data.toString();
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      lines.forEach(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;
        
        // Check if this is a file header from tail -F (format: "==> /path/to/file <==")
        const fileHeaderMatch = trimmedLine.match(/^==>\s+(.+?)\s+<==$/);
        if (fileHeaderMatch) {
          currentFile = fileHeaderMatch[1];
          sendToRenderer('command/output', {
            id: 'rde-debug',
            source: 'stdout',
            text: `[LOGS TAIL] Now tailing: ${currentFile}`
          });
          return;
        }
        
        // Regular log line
        sendToRenderer('logs/line', {
          streamId,
          file: currentFile,
          line: trimmedLine
        });
      });
    });

    // Handle stderr
    childProcess.stderr.on('data', (data) => {
      const errorText = data.toString().trim();
      // Log errors but don't stop the stream
      console.error(`Log stream ${streamId} error:`, errorText);
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stderr',
        text: `[LOGS TAIL ERROR] ${errorText}`
      });
    });
    
    // Debug: Log when process starts
    sendToRenderer('command/output', {
      id: 'rde-debug',
      source: 'stdout',
      text: `[LOGS TAIL] Process started with PID: ${childProcess.pid}, command: ${command}`
    });

    // Handle process exit
    childProcess.on('exit', (code) => {
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stderr',
        text: `[LOGS TAIL] Process exited with code ${code}`
      });
      logStreams.delete(streamId);
      sendToRenderer('logs/stopped', {
        streamId,
        reason: code === 0 ? 'completed' : 'error',
        message: code === 0 ? 'Stream completed' : `Process exited with code ${code}`
      });
    });
    
    // Handle process error
    childProcess.on('error', (error) => {
      sendToRenderer('command/output', {
        id: 'rde-debug',
        source: 'stderr',
        text: `[LOGS TAIL ERROR] Process error: ${error.message}`
      });
      logStreams.delete(streamId);
      sendToRenderer('logs/stopped', {
        streamId,
        reason: 'error',
        message: `Process error: ${error.message}`
      });
    });

    // Store stream info
    logStreams.set(streamId, {
      process: childProcess,
      files,
      mode,
      active: true
    });

    return { success: true, streamId };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * logs/stop
 * Stop a log stream
 */
ipcMain.handle('logs/stop', async (event, { streamId }) => {
  try {
    const stream = logStreams.get(streamId);
    
    if (!stream) {
      return { success: false, error: `Stream ${streamId} not found` };
    }

    if (stream.active && stream.process) {
      stream.process.kill();
      stream.active = false;
      
      sendToRenderer('logs/stopped', {
        streamId,
        reason: 'stopped',
        message: 'Stream stopped by user'
      });
    }

    logStreams.delete(streamId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * command/execute
 * Execute a custom command on the RDE
 */
ipcMain.handle('command/execute', async (event, { target, command }) => {
  // Only allow if connected
  if (currentTarget === null) {
    return { success: false, error: 'Not connected. Please connect first.' };
  }
  
  const commandId = generateCommandId();
  
  try {
    const { process, promise } = executeRemoteCommand('', command, commandId);
    const result = await promise;
    
    return { 
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      output: result.output || '',
      commandId
    };
  } catch (error) {
    return { success: false, error: error.message, commandId };
  }
});

