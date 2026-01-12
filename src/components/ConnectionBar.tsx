import { useState, useEffect } from 'react';
import type { ConnectionState } from '../types';
import { useIPC } from '../hooks/useIPC';
import { useTheme } from '../contexts/ThemeContext';
import './ConnectionBar.css';

interface ConnectionBarProps {
  onTargetChange: (target: string | null) => void;
  showCommandPanel: boolean;
  onToggleCommandPanel: () => void;
  showSDKPanel: boolean;
  onToggleSDKPanel: () => void;
  showGitPanel: boolean;
  onToggleGitPanel: () => void;
  target: string | null;
  connectionState: string;
}

export function ConnectionBar({ 
  onTargetChange, 
  showCommandPanel, 
  onToggleCommandPanel, 
  showSDKPanel, 
  onToggleSDKPanel,
  showGitPanel,
  onToggleGitPanel,
  target,
  connectionState: propConnectionState
}: ConnectionBarProps) {
  const [targetInput, setTargetInput] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [message, setMessage] = useState<string>('');
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const { getConnectionStatus, connect, disconnect, onRdeStatus, getGitInfo } = useIPC();
  const { theme, toggleTheme } = useTheme();

  // Check connection status on mount to restore state after page refresh
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await getConnectionStatus();
        if (status.connected) {
          setConnectionState('connected');
          setMessage('Connected to RDE');
          setTargetInput(status.target || '');
          onTargetChange(status.target || '');
        }
      } catch (error) {
        console.error('Failed to check connection status:', error);
      }
    };
    checkStatus();
  }, [getConnectionStatus, onTargetChange]);

  // Fetch git branch when connected
  useEffect(() => {
    const fetchGitBranch = async () => {
      if (propConnectionState === 'connected' && target) {
        try {
          const result = await getGitInfo(target || '');
          if (result.success) {
            setGitBranch(result.branch);
          } else {
            setGitBranch(null);
          }
        } catch (error) {
          setGitBranch(null);
        }
      } else {
        setGitBranch(null);
      }
    };
    
    fetchGitBranch();
    // Refresh every 30 seconds
    const interval = setInterval(fetchGitBranch, 30000);
    return () => clearInterval(interval);
  }, [propConnectionState, target, getGitInfo]);

  useEffect(() => {
    setConnectionState(propConnectionState as ConnectionState);
  }, [propConnectionState]);

  useEffect(() => {
    const cleanup = onRdeStatus((data) => {
      setConnectionState(data.state as ConnectionState);
      setMessage(data.message || '');
    });
    return cleanup;
  }, [onRdeStatus]);

  const handleConnect = async () => {
    setConnectionState('connecting');
    setMessage('Connecting...');
    try {
      // Target is optional - empty string means default rde
      const result = await connect(targetInput.trim() || '');
      if (!result.success) {
        setConnectionState('error');
        setMessage(result.error || 'Connection failed');
        onTargetChange(null);
      } else {
        onTargetChange(targetInput.trim() || '');
      }
    } catch (error) {
      setConnectionState('error');
      setMessage(error instanceof Error ? error.message : 'Connection failed');
      onTargetChange(null);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      onTargetChange(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Disconnect failed');
    }
  };

  const getStatusColor = () => {
    switch (connectionState) {
      case 'connected':
        return '#4caf50';
      case 'connecting':
        return '#ff9800';
      case 'error':
        return '#f44336';
      default:
        return '#9e9e9e';
    }
  };

  return (
    <div className="connection-bar">
      <div className="connection-bar-left">
        <input
          type="text"
          className="target-input"
          placeholder="RDE Target (optional, e.g. my-rde-env)"
          value={targetInput}
          onChange={(e) => setTargetInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
          disabled={connectionState === 'connected' || connectionState === 'connecting'}
        />
        <button
          className="btn btn-primary"
          onClick={handleConnect}
          disabled={connectionState === 'connected' || connectionState === 'connecting'}
        >
          Connect
        </button>
        <button
          className="btn btn-secondary"
          onClick={handleDisconnect}
          disabled={connectionState === 'disconnected'}
        >
          Disconnect
        </button>
      </div>
      <div className="connection-bar-right">
        {gitBranch && (
          <div className="git-branch-display" onClick={onToggleGitPanel} title="Click to view git changes">
            <span className="git-icon">🌿</span>
            <span className="git-branch-text">{gitBranch}</span>
          </div>
        )}
        <button
          className={`btn btn-icon ${showGitPanel ? 'btn-active' : ''}`}
          onClick={onToggleGitPanel}
          title={showGitPanel ? 'Hide Git Changes' : 'Show Git Changes'}
          style={{
            display: gitBranch ? 'flex' : 'none'
          }}
        >
          📝
        </button>
        <button
          className={`btn btn-icon ${showSDKPanel ? 'btn-active' : ''}`}
          onClick={onToggleSDKPanel}
          title={showSDKPanel ? 'Hide SDK Update' : 'Show SDK Update'}
          style={{
            fontWeight: 'bold',
            fontSize: '14px',
            background: showSDKPanel 
              ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' 
              : 'transparent',
            color: showSDKPanel ? 'white' : 'inherit'
          }}
        >
          🚀 SDK UPDATE
        </button>
        <button
          className="btn btn-icon"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
        <div className="status-indicator">
          <span
            className="status-dot"
            style={{ backgroundColor: getStatusColor() }}
          />
          <span className="status-text">
            {connectionState.charAt(0).toUpperCase() + connectionState.slice(1)}
            {message && `: ${message}`}
          </span>
        </div>
      </div>
    </div>
  );
}

