import { useState, useEffect, useRef } from 'react';
import { useIPC } from '../hooks/useIPC';
import { useToast } from '../contexts/ToastContext';
import type { Service } from '../types';
import './SDKUpdatePanel.css';

interface SDKUpdatePanelProps {
  target: string | null;
  connectionState: string;
}

export function SDKUpdatePanel({ target, connectionState }: SDKUpdatePanelProps) {
  const [serviceName, setServiceName] = useState('');
  const [packageName, setPackageName] = useState('');
  const [output, setOutput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<Service[]>([]);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const { executeCommand, restartService, getSupervisorStatus, onCommandOutput, onSupervisorStatusResult } = useIPC();
  const { showToast } = useToast();

  const isConnected = connectionState === 'connected';

  // Listen for services updates
  useEffect(() => {
    const cleanup = onSupervisorStatusResult((data) => {
      setServices(data.services);
    });
    return cleanup;
  }, [onSupervisorStatusResult]);

  // Fetch services when connected
  useEffect(() => {
    if (isConnected) {
      getSupervisorStatus(target || '').catch((error) => {
        console.error('Failed to fetch services:', error);
      });
    }
  }, [isConnected, target, getSupervisorStatus]);

  // Resolve service name: if user types "captain", find "backend-group:captain"
  const resolveServiceName = (inputName: string): string | null => {
    const trimmed = inputName.trim();
    if (!trimmed) return null;

    // If it already contains a colon, it's likely the full name
    if (trimmed.includes(':')) {
      // Verify it exists in services
      const found = services.find(s => s.name === trimmed);
      return found ? trimmed : null;
    }

    // Try exact match first
    const exactMatch = services.find(s => s.name === trimmed);
    if (exactMatch) return exactMatch.name;

    // Try to find by short name (after colon)
    const shortMatch = services.find(s => {
      const parts = s.name.split(':');
      return parts.length > 1 && parts[parts.length - 1] === trimmed;
    });
    if (shortMatch) return shortMatch.name;

    // Try case-insensitive match
    const caseInsensitiveMatch = services.find(s => 
      s.name.toLowerCase() === trimmed.toLowerCase() || 
      s.name.toLowerCase().endsWith(`:${trimmed.toLowerCase()}`)
    );
    if (caseInsensitiveMatch) return caseInsensitiveMatch.name;

    return null;
  };

  useEffect(() => {
    const cleanup = onCommandOutput((data) => {
      // Show all command output
      if (data.id.startsWith('cmd-') || data.id.startsWith('sdk-')) {
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

  const appendOutput = (text: string) => {
    setOutput(prev => prev + text + '\n');
  };

  const runCommand = async (command: string): Promise<boolean> => {
    appendOutput(`\n$ ${command}\n`);
    try {
      const result = await executeCommand(target || '', command);
      if (result.success) {
        appendOutput(`✓ Command completed successfully (exit code: ${result.exitCode || 0})`);
        return true;
      } else {
        appendOutput(`✗ Command failed: ${result.error || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      appendOutput(`✗ Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  };

  const handleExecute = async () => {
    if (!isConnected || !serviceName.trim() || !packageName.trim()) {
      showToast('Please fill in both service name and package name', 'warning');
      return;
    }

    // Resolve the full service name from the services list
    const resolvedServiceName = resolveServiceName(serviceName.trim());
    if (!resolvedServiceName) {
      appendOutput(`\n❌ Service "${serviceName.trim()}" not found in services list.`);
      appendOutput(`Available services: ${services.map(s => s.name).join(', ')}`);
      showToast(`Service "${serviceName.trim()}" not found`, 'error');
      return;
    }

    // Extract the directory name from the service name (e.g., "backend-group:captain" -> "captain")
    const serviceDirName = resolvedServiceName.includes(':') 
      ? resolvedServiceName.split(':').pop() 
      : resolvedServiceName;

    setLoading(true);
    setOutput('');
    appendOutput('🚀 Starting SDK Update Process...\n');
    appendOutput(`📡 Executing commands on RDE: ${target || 'default'}\n`);
    appendOutput(`Service: ${resolvedServiceName} (resolved from "${serviceName.trim()}")`);
    appendOutput(`Package: ${packageName.trim()}\n`);

    try {
      // Step 1: Upgrade pip, setuptools, wheel (with venv activation)
      appendOutput('\n📦 Step 1: Upgrading pip, setuptools, and wheel...');
      const upgradeCmd = 'bash -c "source /opt/fundbox/backend/src/services/_build/venv/bin/activate && pip install --upgrade pip setuptools wheel"';
      let success = await runCommand(upgradeCmd);
      if (!success) {
        appendOutput('\n⚠️ Warning: pip upgrade failed, but continuing...');
      }

      // Step 2: Force reinstall wheel
      appendOutput('\n📦 Step 2: Force reinstalling wheel...');
      const wheelCmd = 'bash -c "source /opt/fundbox/backend/src/services/_build/venv/bin/activate && pip install --force-reinstall wheel"';
      success = await runCommand(wheelCmd);
      if (!success) {
        appendOutput('\n⚠️ Warning: wheel reinstall failed, but continuing...');
      }

      // Step 3: Navigate to service directory and run install script
      appendOutput(`\n📦 Step 3: Installing SDK package in ${serviceDirName} service...`);
      const serviceDir = `/opt/fundbox/backend/src/services/${serviceDirName}`;
      const installCmd = `bash -c "cd ${serviceDir} && /opt/fundbox/backend/deployment/rde/scripts/install_sdk_package.sh ${packageName.trim()}"`;
      success = await runCommand(installCmd);
      if (!success) {
        appendOutput('\n❌ Failed to install SDK package. Aborting.');
        setLoading(false);
        return;
      }

      // Step 4: Restart the service using the full resolved name
      appendOutput(`\n🔄 Step 4: Restarting ${resolvedServiceName} service...`);
      try {
        const restartResult = await restartService(target || '', resolvedServiceName);
        if (restartResult.success) {
          appendOutput(`✓ Service ${resolvedServiceName} restarted successfully`);
          appendOutput(`\n✅ SDK Update completed successfully!`);
          showToast(`SDK update completed for ${resolvedServiceName}`, 'success');
        } else {
          appendOutput(`✗ Failed to restart service: ${restartResult.error || 'Unknown error'}`);
          appendOutput(`\n⚠️ SDK package installed but service restart failed. Please restart manually.`);
          showToast('SDK installed but service restart failed', 'warning');
        }
      } catch (error) {
        appendOutput(`✗ Error restarting service: ${error instanceof Error ? error.message : 'Unknown error'}`);
        appendOutput(`\n⚠️ SDK package installed but service restart failed. Please restart manually.`);
        showToast('SDK installed but service restart failed', 'warning');
      }

    } catch (error) {
      appendOutput(`\n❌ Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      showToast('SDK update failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setOutput('');
  };

  return (
    <div className="sdk-update-panel">
      <div className="panel-header">
        <h2>🚀 SDK Update</h2>
        <button
          className="btn btn-icon btn-small"
          onClick={handleClear}
          title="Clear output"
          disabled={loading}
        >
          🗑️
        </button>
      </div>
      <div className="sdk-content">
        <div className="sdk-input-section">
          <div className="sdk-input-group">
            <label className="sdk-label">
              <span className="sdk-label-text">Where to install:</span>
              <input
                type="text"
                className="sdk-input"
                placeholder="e.g., captain"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                disabled={loading}
                onKeyPress={(e) => e.key === 'Enter' && !loading && isConnected && handleExecute()}
              />
            </label>
          </div>
          <div className="sdk-input-group">
            <label className="sdk-label">
              <span className="sdk-label-text">Install from:</span>
              <input
                type="text"
                className="sdk-input"
                placeholder="e.g., pre_qual"
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                disabled={loading}
                onKeyPress={(e) => e.key === 'Enter' && !loading && isConnected && handleExecute()}
              />
            </label>
          </div>
          <button
            className="btn btn-primary sdk-execute-btn"
            onClick={handleExecute}
            disabled={!isConnected || loading || !serviceName.trim() || !packageName.trim()}
          >
            {loading ? '⏳ Updating...' : '🚀 Update SDK'}
          </button>
        </div>
        <div className="sdk-output">
          <div className="sdk-output-header">
            <strong>Output:</strong>
          </div>
          <div className="sdk-output-content" ref={outputEndRef}>
            {output || (
              <div className="empty-state">
                {isConnected
                  ? 'Enter service name and package name, then click "Update SDK" to start.'
                  : 'Connect to a target to use SDK Update.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

