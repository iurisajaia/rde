import { useState, useEffect, useRef } from 'react';
import { useIPC } from '../hooks/useIPC';
import { useToast } from '../contexts/ToastContext';
import './CommandPanel.css';

interface CommandPanelProps {
  target: string | null;
  connectionState: string;
}

interface CommandHistory {
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

export function CommandPanel({ target, connectionState }: CommandPanelProps) {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<CommandHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const { executeCommand, onCommandOutput } = useIPC();
  const { showToast } = useToast();

  const isConnected = connectionState === 'connected';

  useEffect(() => {
    const cleanup = onCommandOutput((data) => {
      // Only show command output for custom commands (not debug output)
      if (data.id.startsWith('cmd-') && data.source === 'stdout') {
        setOutput(prev => prev + data.text + '\n');
      }
    });
    return cleanup;
  }, [onCommandOutput]);

  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [output]);

  const handleExecute = async () => {
    if (!isConnected || !command.trim()) return;
    
    setLoading(true);
    setOutput('');
    const commandToExecute = command.trim();
    
    try {
      const result = await executeCommand(target || '', commandToExecute);
      
      if (result.success) {
        const fullOutput = result.output || '';
        setOutput(fullOutput);
        
        // Add to history
        setHistory(prev => [
          { command: commandToExecute, output: fullOutput, exitCode: result.exitCode || 0, timestamp: Date.now() },
          ...prev.slice(0, 49) // Keep last 50 commands
        ]);
        
        showToast('Command executed successfully', 'success', 2000);
      } else {
        setOutput(result.error || 'Command failed');
        showToast(`Command failed: ${result.error}`, 'error');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setOutput(`Error: ${errorMessage}`);
      showToast('Failed to execute command', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleExecute();
    } else if (e.key === 'ArrowUp' && history.length > 0 && !showHistory) {
      e.preventDefault();
      const lastCommand = history[0].command;
      setCommand(lastCommand);
    }
  };

  const handleSelectHistory = (historyItem: CommandHistory) => {
    setCommand(historyItem.command);
    setOutput(historyItem.output);
    setShowHistory(false);
  };

  const handleClear = () => {
    setOutput('');
  };

  return (
    <div className="command-panel">
      <div className="panel-header">
        <h2>Command Console</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {loading && <span className="loading-spinner" />}
          <button
            className="btn btn-icon btn-small"
            onClick={() => setShowHistory(!showHistory)}
            title="Toggle history"
          >
            📜
          </button>
          <button
            className="btn btn-secondary btn-small"
            onClick={handleClear}
            disabled={!output}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="command-content">
        {showHistory && history.length > 0 && (
          <div className="command-history">
            <div className="history-header">Command History</div>
            <div className="history-list">
              {history.map((item, index) => (
                <div
                  key={index}
                  className="history-item"
                  onClick={() => handleSelectHistory(item)}
                >
                  <div className="history-command">{item.command}</div>
                  <div className="history-meta">
                    Exit: {item.exitCode} | {new Date(item.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="command-input-section">
          <div className="command-input-wrapper">
            <span className="command-prompt">$</span>
            <input
              type="text"
              className="command-input"
              placeholder="Enter command... (⌘/Ctrl+Enter to execute)"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyPress}
              disabled={!isConnected || loading}
            />
            <button
              className="btn btn-primary"
              onClick={handleExecute}
              disabled={!isConnected || loading || !command.trim()}
            >
              {loading ? 'Running...' : 'Execute'}
            </button>
          </div>
          <div className="command-output">
            {output ? (
              <pre className="output-text">{output}</pre>
            ) : (
              <div className="empty-state">
                {isConnected
                  ? 'Enter a command and press ⌘/Ctrl+Enter or click Execute'
                  : 'Connect to a target to run commands.'}
              </div>
            )}
            <div ref={outputEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}



