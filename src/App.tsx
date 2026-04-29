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

type LeftTab = 'services' | 'docker';

function App() {
  const [showCommandPanel, setShowCommandPanel] = useState(false);
  const [showSDKPanel, setShowSDKPanel] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftTab>('services');

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
          />
          <div className="app-content">
            <div className="left-panel-wrapper">
              <div className="left-panel-tabs">
                <button
                  className={`left-panel-tab ${leftTab === 'services' ? 'active' : ''}`}
                  onClick={() => setLeftTab('services')}
                >
                  ⚙️ Services
                </button>
                <button
                  className={`left-panel-tab ${leftTab === 'docker' ? 'active' : ''}`}
                  onClick={() => setLeftTab('docker')}
                >
                  🐳 Docker
                </button>
              </div>
              <div className="left-panel-content">
                {leftTab === 'services'
                  ? <ServicesPanel target={TARGET} connectionState="connected" />
                  : <DockerPanel />
                }
              </div>
            </div>
            <LogsPanel target={TARGET} connectionState="connected" />
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
