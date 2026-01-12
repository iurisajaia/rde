import { useState, useEffect } from 'react';
import { useIPC } from '../hooks/useIPC';
import { useToast } from '../contexts/ToastContext';
import './GitChangesPanel.css';

interface GitChangesPanelProps {
  target: string | null;
  connectionState: string;
}

interface GitChange {
  status: string;
  file: string;
}

export function GitChangesPanel({ target, connectionState }: GitChangesPanelProps) {
  const [branch, setBranch] = useState<string | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const { getGitInfo, getGitDiff } = useIPC();
  const { showToast } = useToast();

  const isConnected = connectionState === 'connected';

  const fetchGitInfo = async () => {
    if (!isConnected || !target) return;
    
    setLoading(true);
    try {
      const result = await getGitInfo(target || '');
      if (result.success) {
        setBranch(result.branch);
        setChanges(result.changes || []);
      } else {
        setBranch(null);
        setChanges([]);
        if (result.error) {
          showToast(`Failed to fetch git info: ${result.error}`, 'error');
        }
      }
    } catch (error) {
      setBranch(null);
      setChanges([]);
      showToast('Failed to fetch git info', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchDiff = async (file: string) => {
    if (!isConnected || !target) return;
    
    setDiffLoading(true);
    setSelectedFile(file);
    try {
      const result = await getGitDiff(target || '', file);
      if (result.success) {
        setDiff(result.diff || '');
      } else {
        setDiff(`Error: ${result.error || 'Failed to load diff'}`);
        showToast(`Failed to load diff for ${file}`, 'error');
      }
    } catch (error) {
      setDiff(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      showToast('Failed to load diff', 'error');
    } finally {
      setDiffLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected && target) {
      fetchGitInfo();
      // Refresh every 30 seconds
      const interval = setInterval(fetchGitInfo, 30000);
      return () => clearInterval(interval);
    } else {
      setBranch(null);
      setChanges([]);
      setSelectedFile(null);
      setDiff('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, target]);

  const getStatusColor = (status: string) => {
    // Git status format: XY where X = staged, Y = unstaged
    // Common values: M (modified), A (added), D (deleted), ?? (untracked)
    if (status === '??' || status.includes('?')) return '#2196f3'; // Untracked
    if (status.includes('M')) return '#ff9800'; // Modified
    if (status.includes('A')) return '#4caf50'; // Added
    if (status.includes('D')) return '#f44336'; // Deleted
    if (status.includes('R')) return '#9c27b0'; // Renamed
    return '#757575'; // Default
  };

  const getStatusLabel = (status: string) => {
    if (status === '??' || status.includes('?')) return 'Untracked';
    if (status.includes('M')) return 'Modified';
    if (status.includes('A')) return 'Added';
    if (status.includes('D')) return 'Deleted';
    if (status.includes('R')) return 'Renamed';
    return status || 'Unknown';
  };

  return (
    <div className="git-changes-panel">
      <div className="panel-header">
        <h2>🌿 Git Changes</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {branch && (
            <span className="git-branch-badge" title="Current branch">
              {branch}
            </span>
          )}
          <button
            className="btn btn-icon btn-small"
            onClick={fetchGitInfo}
            disabled={loading}
            title="Refresh"
          >
            {loading ? '⏳' : '🔄'}
          </button>
        </div>
      </div>
      <div className="git-changes-content">
        {loading && changes.length === 0 ? (
          <div className="empty-state">Loading git changes...</div>
        ) : changes.length === 0 ? (
          <div className="empty-state">
            {isConnected
              ? 'No uncommitted changes'
              : 'Connect to a target to view git changes.'}
          </div>
        ) : (
          <div className="git-changes-layout">
            <div className="git-changes-list">
              <div className="git-changes-header">
                Changed Files ({changes.length})
              </div>
              <div className="git-files-list">
                {changes.map((change, idx) => (
                  <div
                    key={idx}
                    className={`git-file-item ${selectedFile === change.file ? 'selected' : ''}`}
                    onClick={() => fetchDiff(change.file)}
                  >
                    <span
                      className="git-file-status"
                      style={{ backgroundColor: getStatusColor(change.status) }}
                    >
                      {getStatusLabel(change.status)}
                    </span>
                    <span className="git-file-name">{change.file}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="git-diff-viewer">
              {selectedFile ? (
                diffLoading ? (
                  <div className="empty-state">Loading diff...</div>
                ) : (
                  <>
                    <div className="git-diff-header">
                      <strong>{selectedFile}</strong>
                      <button
                        className="btn btn-icon btn-small"
                        onClick={() => {
                          setSelectedFile(null);
                          setDiff('');
                        }}
                        title="Close diff"
                      >
                        ×
                      </button>
                    </div>
                    <div className="git-diff-content">
                      <pre className="diff-text">
                        {diff ? diff.split('\n').map((line, idx) => {
                          const isAdded = line.startsWith('+') && !line.startsWith('+++');
                          const isRemoved = line.startsWith('-') && !line.startsWith('---');
                          const isHeader = line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@');
                          
                          return (
                            <div
                              key={idx}
                              className={`diff-line ${isAdded ? 'diff-added' : ''} ${isRemoved ? 'diff-removed' : ''} ${isHeader ? 'diff-header' : ''}`}
                            >
                              {line}
                            </div>
                          );
                        }) : 'No changes'}
                      </pre>
                    </div>
                  </>
                )
              ) : (
                <div className="empty-state">Select a file to view changes</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

