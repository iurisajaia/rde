import { useState, useEffect } from 'react';
import { ConnectionBar } from './components/ConnectionBar';
import { ServicesPanel } from './components/ServicesPanel';
import { LogsPanel } from './components/LogsPanel';
import { CommandPanel } from './components/CommandPanel';
import { SDKUpdatePanel } from './components/SDKUpdatePanel';
import { GitChangesPanel } from './components/GitChangesPanel';
import { ToastContainer } from './components/ToastContainer';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import type { ConnectionState } from './types';
import { useIPC } from './hooks/useIPC';
import './App.css';

function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [target, setTarget] = useState<string | null>(null);
  const [showCommandPanel, setShowCommandPanel] = useState(false);
  const [showSDKPanel, setShowSDKPanel] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const { getConnectionStatus, onRdeStatus } = useIPC();

  // Check connection status on mount to restore state after page refresh
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await getConnectionStatus();
        if (status.connected) {
          console.log('[App] Restoring connection state:', status);
          setConnectionState('connected');
          // Set target to empty string if not provided (default RDE)
          setTarget(status.target || '');
        }
      } catch (error) {
        console.error('[App] Failed to check connection status:', error);
      }
    };
    checkStatus();
  }, [getConnectionStatus]);

  useEffect(() => {
    const cleanup = onRdeStatus((data) => {
      setConnectionState(data.state as ConnectionState);
      if (data.state === 'connected' && data.message) {
        // Extract target from message if possible, or maintain current target
        // For now, we'll keep target separate and update it on connect
      }
    });
    return cleanup;
  }, [onRdeStatus]);

  // Update target when connection succeeds
  useEffect(() => {
    if (connectionState === 'connected' && !target) {
      // Target will be set by ConnectionBar component
    } else if (connectionState === 'disconnected') {
      setTarget(null);
    }
  }, [connectionState, target]);

  return (
    <ThemeProvider>
      <ToastProvider>
        <div className="app">
          <ConnectionBar 
            onTargetChange={setTarget} 
            showCommandPanel={showCommandPanel}
            onToggleCommandPanel={() => setShowCommandPanel(!showCommandPanel)}
            showSDKPanel={showSDKPanel}
            onToggleSDKPanel={() => setShowSDKPanel(!showSDKPanel)}
            showGitPanel={showGitPanel}
            onToggleGitPanel={() => setShowGitPanel(!showGitPanel)}
            target={target}
            connectionState={connectionState}
          />
          <div className="app-content">
            <ServicesPanel target={target} connectionState={connectionState} />
            <LogsPanel target={target} connectionState={connectionState} />
            {showSDKPanel && (
              <SDKUpdatePanel target={target} connectionState={connectionState} />
            )}
            {showGitPanel && (
              <GitChangesPanel target={target} connectionState={connectionState} />
            )}
            {showCommandPanel && (
              <CommandPanel target={target} connectionState={connectionState} />
            )}
          </div>
          <ToastContainer />
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;

