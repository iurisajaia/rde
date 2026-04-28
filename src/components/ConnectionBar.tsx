import { useState, useEffect } from 'react';
import { useIPC } from '../hooks/useIPC';
import { useTheme } from '../contexts/ThemeContext';
import './ConnectionBar.css';

interface ConnectionBarProps {
  showCommandPanel: boolean;
  onToggleCommandPanel: () => void;
  showSDKPanel: boolean;
  onToggleSDKPanel: () => void;
  showGitPanel: boolean;
  onToggleGitPanel: () => void;
  showDockerPanel: boolean;
  onToggleDockerPanel: () => void;
}

export function ConnectionBar({
  showCommandPanel,
  onToggleCommandPanel,
  showSDKPanel,
  onToggleSDKPanel,
  showGitPanel,
  onToggleGitPanel,
  showDockerPanel,
  onToggleDockerPanel,
}: ConnectionBarProps) {
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const { getGitInfo } = useIPC();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const fetch = async () => {
      try {
        const result = await getGitInfo('');
        setGitBranch(result.success && result.branch != null ? result.branch : null);
      } catch {
        setGitBranch(null);
      }
    };
    fetch();
    const interval = setInterval(fetch, 30000);
    return () => clearInterval(interval);
  }, [getGitInfo]);

  return (
    <div className="connection-bar">
      <div className="connection-bar-left">
        <div className="status-indicator">
          <span className="status-dot" style={{ backgroundColor: '#4caf50' }} />
          <span className="status-text">UI preview</span>
        </div>
        {gitBranch && (
          <div className="git-branch-display" onClick={onToggleGitPanel} title="Click to view git changes">
            <span className="git-icon">🌿</span>
            <span className="git-branch-text">{gitBranch}</span>
          </div>
        )}
      </div>
      <div className="connection-bar-right">
        {gitBranch && (
          <button
            className={`btn btn-icon ${showGitPanel ? 'btn-active' : ''}`}
            onClick={onToggleGitPanel}
            title={showGitPanel ? 'Hide Git Changes' : 'Show Git Changes'}
          >
            📝
          </button>
        )}
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
          className={`btn btn-icon ${showDockerPanel ? 'btn-active' : ''}`}
          onClick={onToggleDockerPanel}
          title={showDockerPanel ? 'Hide Docker' : 'Show Docker'}
          style={{
            background: showDockerPanel ? '#0277bd' : 'transparent',
            color: showDockerPanel ? 'white' : 'inherit',
          }}
        >
          🐳
        </button>
        <button
          className={`btn btn-icon ${showCommandPanel ? 'btn-active' : ''}`}
          onClick={onToggleCommandPanel}
          title={showCommandPanel ? 'Hide Command Panel' : 'Show Command Panel'}
        >
          &gt;_
        </button>
        <button
          className="btn btn-icon"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      </div>
    </div>
  );
}
