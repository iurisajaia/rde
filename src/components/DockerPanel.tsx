import { useState, useEffect, useCallback } from 'react';
import { API_BASE_URL } from '../api-config';
import { useToast } from '../contexts/ToastContext';
import './DockerPanel.css';

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
}

async function fetchContainers(): Promise<DockerContainer[]> {
  const res = await fetch(`${API_BASE_URL}/docker/containers`);
  const data = await res.json();
  return data.success ? data.containers : [];
}

async function containerAction(containerId: string, action: 'start' | 'stop' | 'restart') {
  const res = await fetch(`${API_BASE_URL}/docker/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ containerId, action }),
  });
  return res.json();
}

function shortImage(image: string) {
  // Strip ECR prefix, keep just the name:tag
  const parts = image.split('/');
  return parts[parts.length - 1];
}

function formatPorts(ports: string) {
  if (!ports) return null;
  // Show just the host→container mappings, one per line
  return ports.split(', ').map(p => {
    const m = p.match(/0\.0\.0\.0:(\d+)->(\d+)/);
    return m ? `${m[1]}→${m[2]}` : null;
  }).filter(Boolean).join('  ');
}

export function DockerPanel() {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchContainers();
      setContainers(data);
    } catch (e) {
      showToast('Failed to load Docker containers', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (container: DockerContainer, action: 'start' | 'stop' | 'restart') => {
    setPending(p => new Set(p).add(container.id));
    try {
      const result = await containerAction(container.id, action);
      if (result.success) {
        showToast(`${container.name} ${action}ed`, 'success', 2000);
        await load();
      } else {
        showToast(`Failed to ${action} ${container.name}: ${result.stderr || result.output}`, 'error');
      }
    } catch (e) {
      showToast(`Error: ${action} failed`, 'error');
    } finally {
      setPending(p => { const n = new Set(p); n.delete(container.id); return n; });
    }
  };

  const isRunning = (c: DockerContainer) => c.state === 'running';

  return (
    <div className="docker-panel">
      <div className="panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2>🐳 Docker</h2>
          {loading && <div className="loading-spinner" />}
        </div>
        <button className="btn btn-icon" onClick={load} title="Refresh" disabled={loading}>↻</button>
      </div>

      {containers.length === 0 && !loading ? (
        <div className="empty-state">No containers found</div>
      ) : (
        <div className="docker-table-container">
          <table className="docker-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>Status</th>
                <th>Ports</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map(c => {
                const isPending = pending.has(c.id);
                const running = isRunning(c);
                const ports = formatPorts(c.ports);
                return (
                  <tr key={c.id} className={running ? '' : 'container-stopped'}>
                    <td>
                      <span className="container-name">{c.name}</span>
                      <span className="container-id">{c.id.substring(0, 8)}</span>
                    </td>
                    <td>
                      <span className="container-image" title={c.image}>{shortImage(c.image)}</span>
                    </td>
                    <td>
                      <span className={`state-badge state-${running ? 'running' : 'stopped'}`}>
                        {c.state}
                      </span>
                      <div className="container-uptime">{c.status}</div>
                    </td>
                    <td>
                      <span className="container-ports">{ports || '—'}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {!running && (
                          <button
                            className="btn btn-small btn-success"
                            onClick={() => handleAction(c, 'start')}
                            disabled={isPending}
                            title="Start"
                          >
                            {isPending ? '…' : 'Start'}
                          </button>
                        )}
                        {running && (
                          <>
                            <button
                              className="btn btn-small btn-warning"
                              onClick={() => handleAction(c, 'stop')}
                              disabled={isPending}
                              title="Stop"
                            >
                              {isPending ? '…' : 'Stop'}
                            </button>
                            <button
                              className="btn btn-small btn-primary"
                              onClick={() => handleAction(c, 'restart')}
                              disabled={isPending}
                              title="Restart"
                            >
                              {isPending ? '…' : 'Restart'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
