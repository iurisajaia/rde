import { useState } from 'react';
import { ConnectionBar } from './components/ConnectionBar';
import { ServicesPanel } from './components/ServicesPanel';
import { LogsPanel } from './components/LogsPanel';
import { CommandPanel } from './components/CommandPanel';
import { SDKUpdatePanel } from './components/SDKUpdatePanel';
import { GitChangesPanel } from './components/GitChangesPanel';
import { DockerPanel } from './components/DockerPanel';
import { ToastContainer } from './components/ToastContainer';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import './App.css';

const TARGET = 'local';

function App() {
  const [showCommandPanel, setShowCommandPanel] = useState(false);
  const [showSDKPanel, setShowSDKPanel] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [showDockerPanel, setShowDockerPanel] = useState(false);

  return (
    <ThemeProvider>
      <ToastProvider>
        <div className="app">
          <ConnectionBar
            showCommandPanel={showCommandPanel}
            onToggleCommandPanel={() => setShowCommandPanel(p => !p)}
            showSDKPanel={showSDKPanel}
            onToggleSDKPanel={() => setShowSDKPanel(p => !p)}
            showGitPanel={showGitPanel}
            onToggleGitPanel={() => setShowGitPanel(p => !p)}
            showDockerPanel={showDockerPanel}
            onToggleDockerPanel={() => setShowDockerPanel(p => !p)}
          />
          <div className="app-content">
            <ServicesPanel target={TARGET} connectionState="connected" />
            <LogsPanel target={TARGET} connectionState="connected" />
            {showDockerPanel && <DockerPanel />}
            {showSDKPanel && (
              <SDKUpdatePanel target={TARGET} connectionState="connected" />
            )}
            {showGitPanel && (
              <GitChangesPanel target={TARGET} connectionState="connected" />
            )}
            {showCommandPanel && (
              <CommandPanel target={TARGET} connectionState="connected" />
            )}
          </div>
          <ToastContainer />
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
