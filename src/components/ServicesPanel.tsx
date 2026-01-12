import { useState, useEffect, useRef } from 'react';
import type { Service } from '../types';
import { useIPC } from '../hooks/useIPC';
import { useToast } from '../contexts/ToastContext';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import './ServicesPanel.css';

interface ServicesPanelProps {
  target: string | null;
  connectionState: string;
}

interface GroupedServices {
  [group: string]: Service[];
}

export function ServicesPanel({ target, connectionState }: ServicesPanelProps) {
  const [services, setServices] = useState<Service[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [pendingOperations, setPendingOperations] = useState<Set<string>>(new Set());
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [groupByGroup, setGroupByGroup] = useState(true);
  const [showColumns] = useState({
    name: true,
    state: true,
    extra: false,
  });
  const { getSupervisorStatus, restartService, startService, stopService, bulkServiceOperation, onSupervisorStatusResult } = useIPC();
  const { showToast } = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const cleanup = onSupervisorStatusResult((data) => {
      setServices(data.services);
      setLoading(false);
    });
    return cleanup;
  }, [onSupervisorStatusResult]);

  // Keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 'r',
      meta: true,
      handler: () => {
        if (isConnected && !loading) {
          handleRefresh();
        }
      },
    },
    {
      key: 'f',
      meta: true,
      handler: () => {
        searchInputRef.current?.focus();
      },
    },
  ]);

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Automatically fetch supervisor status when connected
  useEffect(() => {
    if (connectionState === 'connected') {
      console.log('[ServicesPanel] Connection restored, fetching services...');
      const timer = setTimeout(() => {
        setLoading(true);
        getSupervisorStatus(target || '').catch((error) => {
          console.error('Failed to refresh status:', error);
          setLoading(false);
          showToast('Failed to refresh services', 'error');
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [connectionState, target, getSupervisorStatus, showToast]);

  const handleRefresh = async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      await getSupervisorStatus(target || '');
      showToast('Services refreshed', 'success', 2000);
    } catch (error) {
      console.error('Failed to refresh status:', error);
      setLoading(false);
      showToast('Failed to refresh services', 'error');
    }
  };

  const showNotification = (title: string, body: string) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          new Notification(title, { body });
        }
      });
    }
  };

  const handleServiceOperation = async (serviceName: string, operation: 'start' | 'stop' | 'restart') => {
    if (!isConnected || pendingOperations.has(serviceName)) return;
    
    setPendingOperations(prev => new Set(prev).add(serviceName));
    try {
      let result;
      if (operation === 'restart') {
        result = await restartService(target || '', serviceName);
      } else if (operation === 'start') {
        result = await startService(target || '', serviceName);
      } else {
        result = await stopService(target || '', serviceName);
      }
      
      if (result.success && result.serviceName && result.newState) {
        const oldService = services.find(s => s.name === serviceName);
        const stateChanged = oldService && oldService.state !== result.newState;
        
        setServices((prevServices) =>
          prevServices.map((service) =>
            service.name === result.serviceName
              ? { ...service, state: result.newState! }
              : service
          )
        );
        
        const message = `${operation === 'restart' ? 'Restarted' : operation === 'start' ? 'Started' : 'Stopped'} ${serviceName}`;
        showToast(message, 'success');
        
        // Show notification if state changed
        if (stateChanged) {
          showNotification(
            `Service ${result.newState}`,
            `${serviceName} is now ${result.newState}`
          );
        }
      } else {
        showToast(`Failed to ${operation} ${serviceName}`, 'error');
        await getSupervisorStatus(target || '');
      }
    } catch (error) {
      console.error(`Failed to ${operation} service:`, error);
      showToast(`Failed to ${operation} service`, 'error');
      await getSupervisorStatus(target || '');
    } finally {
      setPendingOperations(prev => {
        const next = new Set(prev);
        next.delete(serviceName);
        return next;
      });
    }
  };

  const handleBulkOperation = async (operation: 'start' | 'stop' | 'restart') => {
    if (!isConnected || selectedServices.size === 0) return;
    
    const serviceNames = Array.from(selectedServices);
    setPendingOperations(prev => new Set([...prev, ...serviceNames]));
    
    try {
      const result = await bulkServiceOperation(target || '', serviceNames, operation);
      
      if (result.success && result.results) {
        const successCount = result.results.filter(r => r.success).length;
        const failedCount = result.results.length - successCount;
        
        // Update services
        setServices((prevServices) => {
          const updated = [...prevServices];
          result.results!.forEach(r => {
            if (r.success && r.newState) {
              const index = updated.findIndex(s => s.name === r.serviceName);
              if (index !== -1) {
                updated[index] = { ...updated[index], state: r.newState };
              }
            }
          });
          return updated;
        });
        
        if (failedCount === 0) {
          showToast(`${operation === 'restart' ? 'Restarted' : operation === 'start' ? 'Started' : 'Stopped'} ${successCount} service(s)`, 'success');
        } else {
          showToast(`${operation === 'restart' ? 'Restarted' : operation === 'start' ? 'Started' : 'Stopped'} ${successCount} service(s), ${failedCount} failed`, 'warning');
        }
        
        setSelectedServices(new Set());
      } else {
        showToast(`Failed to ${operation} services`, 'error');
      }
    } catch (error) {
      console.error(`Failed to ${operation} services:`, error);
      showToast(`Failed to ${operation} services`, 'error');
    } finally {
      setPendingOperations(prev => {
        const next = new Set(prev);
        serviceNames.forEach(name => next.delete(name));
        return next;
      });
    }
  };

  const handleToggleService = (serviceName: string) => {
    setSelectedServices(prev => {
      const next = new Set(prev);
      if (next.has(serviceName)) {
        next.delete(serviceName);
      } else {
        next.add(serviceName);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedServices.size === filteredServices.length) {
      setSelectedServices(new Set());
    } else {
      setSelectedServices(new Set(filteredServices.map(s => s.name)));
    }
  };

  const handleCopyServiceName = (serviceName: string) => {
    navigator.clipboard.writeText(serviceName);
    showToast('Service name copied to clipboard', 'success', 1500);
  };

  const handleOpenServiceLogs = (serviceName: string) => {
    // Extract log file name from service name (e.g., "backend-group:api" -> "api.log")
    const logFileName = serviceName.split(':').pop() || serviceName;
    const logPath = `/opt/fundbox/logs/${logFileName}.log`;
    
    // Dispatch custom event that LogsPanel can listen to, including service name
    window.dispatchEvent(new CustomEvent('openLogFile', { detail: { file: logPath, serviceName } }));
    showToast(`Opening logs for ${serviceName}`, 'info', 2000);
  };

  const filteredServices = services.filter((service) =>
    service.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group services by supervisor group
  const groupedServices: GroupedServices = groupByGroup
    ? filteredServices.reduce((acc, service) => {
        const group = service.name.includes(':') ? service.name.split(':')[0] : 'ungrouped';
        if (!acc[group]) acc[group] = [];
        acc[group].push(service);
        return acc;
      }, {} as GroupedServices)
    : { 'all': filteredServices };

  const isConnected = connectionState === 'connected';
  const hasSelection = selectedServices.size > 0;

  return (
    <>
      {isCollapsed ? (
        <div className="services-panel-collapsed">
          <button
            className="collapse-button-expand"
            onClick={() => setIsCollapsed(false)}
            aria-label="Expand Services Panel"
            title="Expand Services Panel"
          >
            ▶
          </button>
        </div>
      ) : (
        <div className="services-panel">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                className="collapse-button"
                onClick={() => setIsCollapsed(true)}
                aria-label="Collapse Services Panel"
                title="Collapse Services Panel"
              >
                ◀
              </button>
              <h2>Services</h2>
              {loading && <span className="loading-spinner" />}
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                className="btn btn-icon"
                onClick={() => setGroupByGroup(!groupByGroup)}
                title="Toggle grouping"
              >
                {groupByGroup ? '📁' : '📄'}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleRefresh}
                disabled={!isConnected || loading}
              >
                {loading ? 'Loading...' : 'Refresh Status'}
              </button>
            </div>
          </div>
          <>
          <div className="panel-search">
            <input
              ref={searchInputRef}
              type="text"
              className="search-input"
              placeholder="Search services... (⌘F)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="btn btn-icon btn-clear"
                onClick={() => setSearchQuery('')}
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
          
          {hasSelection && (
            <div className="bulk-actions-bar">
              <span>{selectedServices.size} selected</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="btn btn-small btn-success"
                  onClick={() => handleBulkOperation('start')}
                  disabled={!isConnected || pendingOperations.size > 0}
                >
                  Start All
                </button>
                <button
                  className="btn btn-small btn-warning"
                  onClick={() => handleBulkOperation('stop')}
                  disabled={!isConnected || pendingOperations.size > 0}
                >
                  Stop All
                </button>
                <button
                  className="btn btn-small btn-primary"
                  onClick={() => handleBulkOperation('restart')}
                  disabled={!isConnected || pendingOperations.size > 0}
                >
                  Restart All
                </button>
                <button
                  className="btn btn-small btn-secondary"
                  onClick={() => setSelectedServices(new Set())}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="services-table-container">
            {filteredServices.length === 0 ? (
              <div className="empty-state">
                {isConnected
                  ? 'No services found. Click "Refresh Status" to load services.'
                  : 'Connect to a target to view services.'}
              </div>
            ) : (
              Object.entries(groupedServices).map(([group, groupServices]) => (
                <div key={group} className="service-group">
                  {groupByGroup && group !== 'all' && (
                    <div className="service-group-header">
                      <strong>{group}</strong> ({groupServices.length})
                    </div>
                  )}
                  <table className="services-table">
                    <thead>
                      <tr>
                        {showColumns.name && <th>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={groupServices.every(s => selectedServices.has(s.name))}
                              onChange={handleSelectAll}
                            />
                            Service
                          </label>
                        </th>}
                        {showColumns.state && <th>State</th>}
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupServices.map((service) => {
                        const isPending = pendingOperations.has(service.name);
                        const isSelected = selectedServices.has(service.name);
                        return (
                          <tr key={service.name} className={isSelected ? 'row-selected' : ''}>
                            {showColumns.name && (
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => handleToggleService(service.name)}
                                  />
                                  <span 
                                    className="service-name"
                                    onClick={() => handleCopyServiceName(service.name)}
                                    title="Click to copy"
                                    style={{ cursor: 'pointer' }}
                                  >
                                    {service.name}
                                  </span>
                                </div>
                              </td>
                            )}
                            {showColumns.state && (
                              <td>
                                <span className={`state-badge state-${service.state.toLowerCase()}`}>
                                  {service.state}
                                </span>
                              </td>
                            )}
                            <td>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                {service.state !== 'RUNNING' && (
                                  <button
                                    className="btn btn-small btn-success"
                                    onClick={() => handleServiceOperation(service.name, 'start')}
                                    disabled={!isConnected || isPending}
                                    title="Start service"
                                  >
                                    {isPending ? '...' : 'Start'}
                                  </button>
                                )}
                                {service.state === 'RUNNING' && (
                                  <>
                                    <button
                                      className="btn btn-small btn-warning"
                                      onClick={() => handleServiceOperation(service.name, 'stop')}
                                      disabled={!isConnected || isPending}
                                      title="Stop service"
                                    >
                                      {isPending ? '...' : 'Stop'}
                                    </button>
                                    <button
                                      className="btn btn-small btn-primary"
                                      onClick={() => handleServiceOperation(service.name, 'restart')}
                                      disabled={!isConnected || isPending}
                                      title="Restart service"
                                    >
                                      {isPending ? '...' : 'Restart'}
                                    </button>
                                  </>
                                )}
                                <button
                                  className="btn btn-small btn-icon"
                                  onClick={() => handleOpenServiceLogs(service.name)}
                                  disabled={!isConnected}
                                  title="Open logs"
                                >
                                  📋
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>
          </>
        </div>
      )}
    </>
  );
}
