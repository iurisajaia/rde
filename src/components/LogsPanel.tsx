import { useState, useEffect, useRef } from 'react';
import type { LogLine, LogBookmark } from '../types';
import { useIPC } from '../hooks/useIPC';
import { useToast } from '../contexts/ToastContext';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import './LogsPanel.css';

interface LogsPanelProps {
  target: string | null;
  connectionState: string;
}

type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'ALL';

export function LogsPanel({ target, connectionState }: LogsPanelProps) {
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [filteredLogFiles, setFilteredLogFiles] = useState<string[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileListCollapsed, setFileListCollapsed] = useState(false);
  const [logMonitorLines, setLogMonitorLines] = useState<LogLine[]>([]);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [tabStreams, setTabStreams] = useState<Map<string, string | null>>(new Map([['main', null]]));
  const [tabFollowedFiles, setTabFollowedFiles] = useState<Map<string, Set<string>>>(new Map([['main', new Set()]]));
  const [logMonitorSearchQuery, setLogMonitorSearchQuery] = useState('');
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel>('ALL');
  const [searchResultIndex, setSearchResultIndex] = useState<number>(-1);
  const [loading, setLoading] = useState(false);
  const [bookmarks, setBookmarks] = useState<LogBookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('main');
  const [tabs, setTabs] = useState<Map<string, LogLine[]>>(new Map([['main', []]]));
  const [lineWrap, setLineWrap] = useState(true);
  const [fontSize, setFontSize] = useState(12);
  const [autoScroll, setAutoScroll] = useState(true);
  const logMonitorEndRef = useRef<HTMLDivElement>(null);
  const logMonitorContainerRef = useRef<HTMLDivElement>(null);
  const lineCounterRef = useRef(0);
  const { listLogFiles, tailLogs, stopLogStream, onLogsLine, onLogsStopped } = useIPC();
  const { showToast } = useToast();

  // Listen for openLogFile event from ServicesPanel
  useEffect(() => {
    const handleOpenLogFile = async (event: CustomEvent<{ file: string; serviceName?: string }>) => {
      const file = event.detail.file;
      const serviceName = event.detail.serviceName;
      if (logFiles.includes(file)) {
        // Stop all existing streams first - only one stream at a time
        const allStreams = Array.from(tabStreams.values()).filter(id => id !== null) as string[];
        for (const streamId of allStreams) {
          try {
            await stopLogStream(streamId);
          } catch (error) {
            console.error('Failed to stop existing stream:', error);
          }
        }
        
        // Clear all streams
        setTabStreams(prev => {
          const next = new Map(prev);
          for (const key of next.keys()) {
            next.set(key, null);
          }
          return next;
        });
        
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          for (const key of next.keys()) {
            next.set(key, new Set());
          }
          return next;
        });
        
        setActiveStreamId(null);
        
        // Create a new tab for this log file with service name if available, otherwise file name
        // Calculate tab name using current tabs state
        const newTabName = generateUniqueTabName([file], tabs, serviceName);
        
        setTabs(prev => {
          const next = new Map(prev);
          next.set(newTabName, []); // Empty tab
          return next;
        });
        setTabStreams(prev => {
          const next = new Map(prev);
          next.set(newTabName, null);
          return next;
        });
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          next.set(newTabName, new Set());
          return next;
        });
        setActiveTab(newTabName);
        setSelectedFiles(new Set([file]));
        
        // Start tailing in the new tab
        await startTailingInTab([file], newTabName);
      } else {
        showToast(`Log file not found: ${file}`, 'warning');
      }
    };

    const handler = handleOpenLogFile as unknown as EventListener;
    window.addEventListener('openLogFile', handler);
    return () => window.removeEventListener('openLogFile', handler);
  }, [logFiles, showToast, activeStreamId, tabs]);

  // Filter log files based on search
  useEffect(() => {
    if (!fileSearchQuery) {
      setFilteredLogFiles(logFiles);
    } else {
      setFilteredLogFiles(logFiles.filter(file => 
        file.toLowerCase().includes(fileSearchQuery.toLowerCase())
      ));
    }
  }, [fileSearchQuery, logFiles]);

  useEffect(() => {
    const cleanup = onLogsLine((data) => {
      lineCounterRef.current += 1;
      const newLine: LogLine = {
        ...data,
        timestamp: Date.now(),
        lineNumber: lineCounterRef.current,
      };
      
      // Find which tab this stream belongs to
      const streamTab = Array.from(tabStreams.entries()).find(([_, streamId]) => streamId === data.streamId)?.[0] || activeTab;
      
      // Add to the appropriate tab
      setTabs(prev => {
        const next = new Map(prev);
        const currentTabLines = next.get(streamTab) || [];
        next.set(streamTab, [...currentTabLines, newLine]);
        return next;
      });
      
      // Also update logMonitorLines if this is the active tab
      if (streamTab === activeTab) {
        setLogMonitorLines(prev => [...prev, newLine]);
      }
    });
    return cleanup;
  }, [onLogsLine, activeTab, tabStreams]);

  useEffect(() => {
    const cleanup = onLogsStopped((data) => {
      if (data.streamId === activeStreamId) {
        setActiveStreamId(null);
        showToast('Log stream stopped', 'info');
      }
    });
    return cleanup;
  }, [onLogsStopped, activeStreamId, showToast]);

  // Switch tab content when activeTab changes
  useEffect(() => {
    const tabLines = tabs.get(activeTab) || [];
    setLogMonitorLines(tabLines);
    const tabStreamId = tabStreams.get(activeTab) || null;
    setActiveStreamId(tabStreamId);
  }, [activeTab, tabs, tabStreams]);

  // Auto-scroll log monitor
  useEffect(() => {
    if (autoScroll && logMonitorEndRef.current) {
      logMonitorEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logMonitorLines, autoScroll]);

  // Keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 'c',
      meta: true,
      shift: true,
      handler: () => {
        handleClear();
      },
    },
  ]);

  const handleLoadLogFiles = async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const result = await listLogFiles(target || '');
      if (result.success && result.files) {
        setLogFiles(result.files);
        setFilteredLogFiles(result.files);
        showToast(`Loaded ${result.files.length} log files`, 'success', 2000);
      }
    } catch (error) {
      console.error('Failed to load log files:', error);
      showToast('Failed to load log files', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connectionState === 'connected' && logFiles.length === 0) {
      console.log('[LogsPanel] Connection restored, fetching log files...');
      const timer = setTimeout(() => {
        setLoading(true);
        listLogFiles(target || '').then((result) => {
          if (result.success && result.files) {
            setLogFiles(result.files);
            setFilteredLogFiles(result.files);
          }
          setLoading(false);
        }).catch((error) => {
          console.error('Failed to load log files:', error);
          setLoading(false);
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [connectionState, target, listLogFiles, logFiles.length]);

  const handleToggleFile = (file: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(file)) {
      newSelected.delete(file);
    } else {
      newSelected.add(file);
    }
    setSelectedFiles(newSelected);
    
    // Stop following if deselecting all files and there's an active stream
    if (newSelected.size === 0 && activeStreamId) {
      handleStopFollow();
    }
  };

  const handleSelectAll = () => {
    if (selectedFiles.size === filteredLogFiles.length) {
      setSelectedFiles(new Set());
      if (activeStreamId) {
        handleStopFollow();
      }
    } else {
      const allFiles = new Set(filteredLogFiles);
      setSelectedFiles(allFiles);
    }
  };

  const handleSelectNone = () => {
    setSelectedFiles(new Set());
    if (activeStreamId) {
      handleStopFollow();
    }
  };

  const startTailingInTab = async (files: string[], tabName: string) => {
    if (!isConnected || files.length === 0) return;
    
    // Stop all existing streams first - only one stream at a time
    const allStreams = Array.from(tabStreams.values()).filter(id => id !== null) as string[];
    for (const streamId of allStreams) {
      try {
        await stopLogStream(streamId);
      } catch (error) {
        console.error('Failed to stop existing stream:', error);
      }
    }
    
    // Clear all tab streams
    setTabStreams(prev => {
      const next = new Map(prev);
      for (const key of next.keys()) {
        next.set(key, null);
      }
      return next;
    });
    
    setTabFollowedFiles(prev => {
      const next = new Map(prev);
      for (const key of next.keys()) {
        next.set(key, new Set());
      }
      return next;
    });
    
    setActiveStreamId(null);
    
    // If tab name is generic (tab-*), rename it based on files
    let finalTabName = tabName;
    if (tabName.startsWith('tab-')) {
      // Calculate new name using current tabs
      finalTabName = generateUniqueTabName(files, tabs);
      
      // Rename the tab if needed
      if (finalTabName !== tabName) {
        setTabs(prev => {
          const next = new Map(prev);
          const lines = next.get(tabName) || [];
          next.delete(tabName);
          next.set(finalTabName, lines);
          return next;
        });
        
        setTabStreams(prev => {
          const next = new Map(prev);
          next.delete(tabName);
          next.set(finalTabName, null);
          return next;
        });
        
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          next.delete(tabName);
          next.set(finalTabName, new Set());
          return next;
        });
        
        // Update active tab if it was the renamed one
        if (activeTab === tabName) {
          setActiveTab(finalTabName);
        }
      }
    }
    
    // Clear the tab's lines
    setTabs(prev => {
      const next = new Map(prev);
      next.set(finalTabName, []);
      return next;
    });
    
    // Clear all tab displays
    setLogMonitorLines([]);
    
    try {
      const result = await tailLogs(target || '', files, 'follow');
      if (result.success && result.streamId) {
        setTabStreams(prev => {
          const next = new Map(prev);
          next.set(finalTabName, result.streamId!);
          return next;
        });
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          // Ensure the tab exists in the map
          if (!next.has(finalTabName)) {
            next.set(finalTabName, new Set());
          }
          next.set(finalTabName, new Set(files));
          return next;
        });
        setActiveStreamId(result.streamId);
        showToast(`Following ${files.length} log file(s)`, 'success', 2000);
      }
    } catch (error) {
      console.error('Failed to start tailing:', error);
      showToast('Failed to start tailing logs', 'error');
    }
  };

  const startTailing = async (files: string[]) => {
    await startTailingInTab(files, activeTab);
  };

  const handleOpenLast = async () => {
    if (!isConnected || selectedFiles.size === 0) return;
    
    // Rename tab if it's a generic tab name
    let finalTabName = activeTab;
    if (activeTab.startsWith('tab-')) {
      finalTabName = generateUniqueTabName(Array.from(selectedFiles), tabs);
      
      if (finalTabName !== activeTab) {
        setTabs(prev => {
          const next = new Map(prev);
          const lines = next.get(activeTab) || [];
          next.delete(activeTab);
          next.set(finalTabName, lines);
          return next;
        });
        
        setTabStreams(prev => {
          const next = new Map(prev);
          const streamId = next.get(activeTab) || null;
          next.delete(activeTab);
          next.set(finalTabName, streamId);
          return next;
        });
        
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          const followedFiles = next.get(activeTab) || new Set();
          next.delete(activeTab);
          next.set(finalTabName, followedFiles);
          return next;
        });
        
        setActiveTab(finalTabName);
      }
    }
    
    setLogMonitorLines([]);
    lineCounterRef.current = 0;
    setLoading(true);
    try {
      const result = await tailLogs(target || '', Array.from(selectedFiles), 'last', 200);
      if (result.success && result.streamId) {
        setTabStreams(prev => {
          const next = new Map(prev);
          next.set(finalTabName, result.streamId!);
          return next;
        });
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          next.set(finalTabName, new Set(Array.from(selectedFiles)));
          return next;
        });
        setActiveStreamId(result.streamId);
        showToast(`Loaded last 200 lines from ${selectedFiles.size} file(s)`, 'success', 2000);
      }
    } catch (error) {
      console.error('Failed to open logs:', error);
      showToast('Failed to open logs', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleFollow = async () => {
    if (!isConnected || selectedFiles.size === 0) return;
    await startTailing(Array.from(selectedFiles));
  };

  const handleStopFollow = async () => {
    if (!activeStreamId) return;
    try {
      await stopLogStream(activeStreamId);
      setActiveStreamId(null);
      // Clear stream from current tab
      setTabStreams(prev => {
        const next = new Map(prev);
        next.set(activeTab, null);
        return next;
      });
      setTabFollowedFiles(prev => {
        const next = new Map(prev);
        next.set(activeTab, new Set());
        return next;
      });
    } catch (error) {
      console.error('Failed to stop log stream:', error);
      showToast('Failed to stop log stream', 'error');
    }
  };

  const handleStopFollowingFile = async (file: string) => {
    const tabStreamId = tabStreams.get(activeTab);
    if (!tabStreamId) return;
    
    const followedFiles = tabFollowedFiles.get(activeTab) || new Set();
    const newFollowedFiles = new Set(followedFiles);
    newFollowedFiles.delete(file);
    
    // If no files left, stop the stream
    if (newFollowedFiles.size === 0) {
      await handleStopFollow();
      return;
    }
    
    // Otherwise, restart the stream with remaining files
    try {
      // Stop current stream
      await stopLogStream(tabStreamId);
      
      // Start new stream with remaining files
      const remainingFiles = Array.from(newFollowedFiles);
      const result = await tailLogs(target || '', remainingFiles, 'follow');
      
      if (result.success && result.streamId) {
        setTabStreams(prev => {
          const next = new Map(prev);
          next.set(activeTab, result.streamId!);
          return next;
        });
        setTabFollowedFiles(prev => {
          const next = new Map(prev);
          next.set(activeTab, newFollowedFiles);
          return next;
        });
        setActiveStreamId(result.streamId);
        showToast(`Stopped following ${getFileName(file)}`, 'info', 2000);
      }
    } catch (error) {
      console.error('Failed to stop following file:', error);
      showToast('Failed to stop following file', 'error');
    }
  };

  const handleClear = () => {
    setLogMonitorLines([]);
    setTabs(new Map([['main', []]]));
    setTabStreams(new Map([['main', null]]));
    setTabFollowedFiles(new Map([['main', new Set()]]));
    setActiveTab('main');
    setActiveStreamId(null);
    lineCounterRef.current = 0;
    showToast('Logs cleared', 'info', 1500);
  };

  const handleCopyLine = (line: string) => {
    navigator.clipboard.writeText(line);
    showToast('Line copied to clipboard', 'success', 1500);
  };

  const handleAddBookmark = (line: LogLine) => {
    const bookmark: LogBookmark = {
      id: `bookmark-${Date.now()}`,
      line,
      createdAt: Date.now(),
    };
    setBookmarks(prev => [...prev, bookmark]);
    showToast('Bookmark added', 'success', 1500);
  };

  const handleRemoveBookmark = (id: string) => {
    setBookmarks(prev => prev.filter(b => b.id !== id));
    showToast('Bookmark removed', 'info', 1500);
  };

  const handleCreateTab = async () => {
    // Stop all existing streams - only one stream at a time
    const allStreams = Array.from(tabStreams.values()).filter(id => id !== null) as string[];
    for (const streamId of allStreams) {
      try {
        await stopLogStream(streamId);
      } catch (error) {
        console.error('Failed to stop existing stream:', error);
      }
    }
    
    // Clear all streams
    setTabStreams(prev => {
      const next = new Map(prev);
      for (const key of next.keys()) {
        next.set(key, null);
      }
      return next;
    });
    
    setTabFollowedFiles(prev => {
      const next = new Map(prev);
      for (const key of next.keys()) {
        next.set(key, new Set());
      }
      return next;
    });
    
    setActiveStreamId(null);
    
    // Clear selected files - give fresh list for new tab
    setSelectedFiles(new Set());
    
    // Always create a new tab with a generic name - it will be renamed when files are selected
    const newTabName = `tab-${Date.now()}`;
    
    setTabs(prev => {
      const next = new Map(prev);
      next.set(newTabName, []); // Create empty tab
      return next;
    });
    setTabStreams(prev => {
      const next = new Map(prev);
      next.set(newTabName, null);
      return next;
    });
    setTabFollowedFiles(prev => {
      const next = new Map(prev);
      next.set(newTabName, new Set());
      return next;
    });
    setActiveTab(newTabName);
    
    // Clear display
    setLogMonitorLines([]);
  };

  const handleCloseTab = async (tabName: string) => {
    if (tabs.size === 1) return; // Don't close the last tab
    
    // Stop stream if this tab has one
    const tabStreamId = tabStreams.get(tabName);
    if (tabStreamId) {
      try {
        await stopLogStream(tabStreamId);
      } catch (error) {
        console.error('Failed to stop tab stream:', error);
      }
    }
    
    setTabs(prev => {
      const next = new Map(prev);
      next.delete(tabName);
      return next;
    });
    setTabStreams(prev => {
      const next = new Map(prev);
      next.delete(tabName);
      return next;
    });
    
    setTabFollowedFiles(prev => {
      const next = new Map(prev);
      next.delete(tabName);
      return next;
    });
    
    if (activeTab === tabName) {
      const remainingTabs = Array.from(tabs.keys()).filter(t => t !== tabName);
      const newActiveTab = remainingTabs[0] || 'main';
      setActiveTab(newActiveTab);
    }
  };

  const handleScrollToTop = () => {
    logMonitorContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleScrollToBottom = () => {
    logMonitorEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const getFileName = (filePath: string) => {
    return filePath.split('/').pop() || filePath;
  };

  const getFileBaseName = (filePath: string) => {
    const fileName = getFileName(filePath);
    // Remove .log extension if present
    return fileName.replace(/\.log$/, '');
  };

  const generateUniqueTabName = (files: string[], currentTabs: Map<string, LogLine[]>, serviceName?: string): string => {
    if (files.length === 0) {
      return `tab-${Date.now()}`;
    }
    
    if (files.length === 1) {
      // If service name is provided, use it; otherwise use file base name
      const baseName = serviceName || getFileBaseName(files[0]);
      // Check if tab name already exists
      const existingTabs = Array.from(currentTabs.keys());
      let tabName = baseName;
      let counter = 1;
      
      while (existingTabs.includes(tabName)) {
        tabName = `${baseName}-${counter}`;
        counter++;
      }
      
      return tabName;
    } else {
      // Multiple files - use first file name + count
      const baseName = getFileBaseName(files[0]);
      const tabName = `${baseName}+${files.length - 1}`;
      
      // Check if tab name already exists
      const existingTabs = Array.from(currentTabs.keys());
      if (existingTabs.includes(tabName)) {
        let counter = 1;
        let uniqueName = `${tabName}-${counter}`;
        while (existingTabs.includes(uniqueName)) {
          counter++;
          uniqueName = `${tabName}-${counter}`;
        }
        return uniqueName;
      }
      
      return tabName;
    }
  };

  const detectLogLevel = (line: string): LogLevel => {
    const upper = line.toUpperCase();
    if (upper.includes('ERROR') || upper.includes('FATAL') || upper.includes('EXCEPTION')) return 'ERROR';
    if (upper.includes('WARN') || upper.includes('WARNING')) return 'WARN';
    if (upper.includes('INFO')) return 'INFO';
    if (upper.includes('DEBUG')) return 'DEBUG';
    return 'ALL';
  };

  const filteredLogMonitorLines = logMonitorLines.filter((line) => {
    const matchesSearch = !logMonitorSearchQuery || 
      line.line.toLowerCase().includes(logMonitorSearchQuery.toLowerCase());
    const matchesLevel = logLevelFilter === 'ALL' || detectLogLevel(line.line) === logLevelFilter;
    return matchesSearch && matchesLevel;
  });

  const logMonitorMatches = logMonitorSearchQuery
    ? filteredLogMonitorLines
        .map((line, idx) => line.line.toLowerCase().includes(logMonitorSearchQuery.toLowerCase()) ? idx : -1)
        .filter(idx => idx !== -1)
    : [];

  const highlightText = (text: string, query: string, isHighlighted: boolean) => {
    if (!query) {
      // Still highlight log levels even without search query
      const parts = text.split(/(ERROR|WARN|WARNING|INFO|DEBUG|FATAL|EXCEPTION)/gi);
      return (
        <>
          {parts.map((part, i) => {
            const level = detectLogLevel(part);
            const isError = level === 'ERROR';
            const isWarn = level === 'WARN';
            return (
              <span
                key={i}
                style={{
                  color: isError ? '#f44336' : isWarn ? '#ff9800' : 'inherit',
                  fontWeight: (isError || isWarn) ? 'bold' : 'normal',
                }}
              >
                {part}
              </span>
            );
          })}
        </>
      );
    }
    
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return (
      <>
        {parts.map((part, i) => {
          const isMatch = part.toLowerCase() === query.toLowerCase();
          const level = detectLogLevel(part);
          const isError = level === 'ERROR';
          const isWarn = level === 'WARN';
          return isMatch ? (
            <span
              key={i}
              style={{
                backgroundColor: isHighlighted ? '#ffeb3b' : '#ffff00',
                color: '#000',
                fontWeight: 'bold',
              }}
            >
              {part}
            </span>
          ) : (
            <span
              key={i}
              style={{
                color: isError ? '#f44336' : isWarn ? '#ff9800' : 'inherit',
                fontWeight: (isError || isWarn) ? 'bold' : 'normal',
              }}
            >
              {part}
            </span>
          );
        })}
      </>
    );
  };

  const navigateSearchResults = (direction: 'next' | 'prev') => {
    if (logMonitorMatches.length === 0) return;
    
    let newIndex: number;
    if (searchResultIndex === -1) {
      newIndex = direction === 'next' ? 0 : logMonitorMatches.length - 1;
    } else {
      newIndex = direction === 'next'
        ? (searchResultIndex + 1) % logMonitorMatches.length
        : (searchResultIndex - 1 + logMonitorMatches.length) % logMonitorMatches.length;
    }
    
    setSearchResultIndex(newIndex);
    setTimeout(() => {
      const element = document.querySelector(`[data-log-monitor-index="${logMonitorMatches[newIndex]}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  };

  useEffect(() => {
    setSearchResultIndex(-1);
  }, [logMonitorSearchQuery]);

  const isConnected = connectionState === 'connected';
  const hasActiveStream = activeStreamId !== null;
  const activeFollowedFiles = tabFollowedFiles.get(activeTab) || new Set();

  return (
    <div className="logs-panel">
      <div className="panel-header">
        <h2>Logs</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            className={`btn btn-icon btn-small ${showBookmarks ? 'btn-active' : ''}`}
            onClick={() => setShowBookmarks(!showBookmarks)}
            title={showBookmarks ? 'Hide Bookmarks' : 'Show Bookmarks'}
          >
            ⭐ {bookmarks.length > 0 && `(${bookmarks.length})`}
          </button>
          {loading && <span className="loading-spinner" />}
          <button
            className="btn btn-primary"
            onClick={handleLoadLogFiles}
            disabled={!isConnected || loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="logs-content">
        {showBookmarks && (
          <div className="bookmarks-panel">
            <div className="bookmarks-header">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Bookmarks ({bookmarks.length})</strong>
                <button
                  className="btn btn-icon btn-small"
                  onClick={() => setShowBookmarks(false)}
                  title="Close bookmarks"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="bookmarks-list">
              {bookmarks.length === 0 ? (
                <div className="empty-state">
                  No bookmarks yet. Click the ⭐ icon on any log line to bookmark it.
                </div>
              ) : (
                bookmarks.map((bookmark) => (
                  <div key={bookmark.id} className="bookmark-item">
                    <div className="bookmark-header">
                      <span className="bookmark-file">{getFileName(bookmark.line.file)}</span>
                      <span className="bookmark-time">
                        {new Date(bookmark.createdAt).toLocaleTimeString()}
                      </span>
                      <button
                        className="btn btn-icon btn-tiny"
                        onClick={() => handleRemoveBookmark(bookmark.id)}
                        title="Remove bookmark"
                      >
                        ×
                      </button>
                    </div>
                    <div className="bookmark-line">
                      {bookmark.line.lineNumber && (
                        <span className="log-line-number">{bookmark.line.lineNumber}</span>
                      )}
                      <span className="bookmark-line-text">{bookmark.line.line}</span>
                    </div>
                    <div className="bookmark-actions">
                      <button
                        className="btn btn-small btn-secondary"
                        onClick={() => handleCopyLine(bookmark.line.line)}
                        title="Copy line"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        <div className={`logs-file-list ${fileListCollapsed ? 'collapsed' : ''}`}>
          <div className="file-list-header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Select log files:</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  className="btn btn-icon btn-small"
                  onClick={() => setFileListCollapsed(!fileListCollapsed)}
                  title={fileListCollapsed ? 'Expand file list' : 'Collapse file list'}
                >
                  {fileListCollapsed ? '▶' : '◀'}
                </button>
                {!fileListCollapsed && (
                  <>
                    <button
                      className="btn btn-icon btn-small"
                      onClick={handleSelectAll}
                      disabled={hasActiveStream}
                      title="Select all"
                    >
                      ✓ All
                    </button>
                    <button
                      className="btn btn-icon btn-small"
                      onClick={handleSelectNone}
                      disabled={hasActiveStream}
                      title="Select none"
                    >
                      ✗ None
                    </button>
                  </>
                )}
              </div>
            </div>
            {!fileListCollapsed && (
              <>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Filter files..."
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                  style={{ flex: 1, minWidth: '150px' }}
                />
                {fileSearchQuery && (
                  <button
                    className="btn btn-icon btn-clear"
                    onClick={() => setFileSearchQuery('')}
                    title="Clear filter"
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>
          {filteredLogFiles.length === 0 ? (
            <div className="empty-state">
              {isConnected
                ? logFiles.length === 0
                  ? 'Click "Refresh" to load log files.'
                  : 'No files match your filter.'
                : 'Connect to a target to view logs.'}
            </div>
          ) : (
            <div className="file-list">
              {filteredLogFiles.map((file) => (
                <label key={file} className="file-item">
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file)}
                    onChange={() => handleToggleFile(file)}
                    disabled={hasActiveStream}
                  />
                  <span>{getFileName(file)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="logs-actions">
            <button
              className="btn btn-primary"
              onClick={handleOpenLast}
              disabled={!isConnected || selectedFiles.size === 0 || hasActiveStream}
            >
              Open (last 200 lines)
            </button>
            <button
              className="btn btn-primary"
              onClick={handleFollow}
              disabled={!isConnected || selectedFiles.size === 0 || hasActiveStream}
            >
              Follow
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleStopFollow}
              disabled={!hasActiveStream}
            >
              Stop Follow
            </button>
            <button className="btn btn-secondary" onClick={handleClear}>
              Clear output
            </button>
          </div>
        </div>
        <div className="logs-output-container">
          {activeFollowedFiles.size > 0 && (
            <div className="active-logs-bar">
              <div className="active-logs-label">Following:</div>
              <div className="active-logs-list">
                {Array.from(activeFollowedFiles).map((file) => (
                  <label key={file} className="active-log-item">
                    <input
                      type="checkbox"
                      checked={true}
                      onChange={() => handleStopFollowingFile(file)}
                    />
                    <span>{getFileName(file)}</span>
                  </label>
                ))}
              </div>
              <button
                className="btn btn-small btn-secondary"
                onClick={handleStopFollow}
                title="Stop following all"
              >
                Stop All
              </button>
            </div>
          )}
          <div className="logs-output log-monitor">
            <div className="output-header">
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1 }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {Array.from(tabs.keys()).map(tabName => (
                    <button
                      key={tabName}
                      className={`btn btn-small ${activeTab === tabName ? 'btn-active' : ''}`}
                      onClick={() => setActiveTab(tabName)}
                      style={{ position: 'relative' }}
                    >
                      {tabName}
                      {tabs.size > 1 && (
                        <span
                          className="tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseTab(tabName);
                          }}
                        >
                          ×
                        </span>
                      )}
                    </button>
                  ))}
                  <button
                    className="btn btn-small btn-icon"
                    onClick={handleCreateTab}
                    title="New tab"
                  >
                    +
                  </button>
                </div>
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, flex: 1, color: 'var(--text-color)' }}>
                  {hasActiveStream && <span className="stream-indicator">● Following</span>}
                </h3>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <select
                  className="log-level-filter"
                  value={logLevelFilter}
                  onChange={(e) => setLogLevelFilter(e.target.value as LogLevel)}
                >
                  <option value="ALL">All Levels</option>
                  <option value="ERROR">ERROR</option>
                  <option value="WARN">WARN</option>
                  <option value="INFO">INFO</option>
                  <option value="DEBUG">DEBUG</option>
                </select>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search logs..."
                  value={logMonitorSearchQuery}
                  onChange={(e) => setLogMonitorSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.shiftKey) {
                      navigateSearchResults('prev');
                    } else if (e.key === 'Enter') {
                      navigateSearchResults('next');
                    }
                  }}
                />
                {logMonitorSearchQuery && (
                  <button
                    className="btn btn-icon btn-clear"
                    onClick={() => setLogMonitorSearchQuery('')}
                    title="Clear search"
                  >
                    ×
                  </button>
                )}
                {logMonitorSearchQuery && logMonitorMatches.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-color)' }}>
                    <button
                      className="btn btn-small btn-icon"
                      onClick={() => navigateSearchResults('prev')}
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                    >
                      ↑
                    </button>
                    <span>
                      {searchResultIndex + 1}/{logMonitorMatches.length}
                    </span>
                    <button
                      className="btn btn-small btn-icon"
                      onClick={() => navigateSearchResults('next')}
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                    >
                      ↓
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <button
                    className="btn btn-icon btn-small"
                    onClick={handleScrollToTop}
                    title="Scroll to top"
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-icon btn-small"
                    onClick={handleScrollToBottom}
                    title="Scroll to bottom"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-icon btn-small"
                    onClick={() => setLineWrap(!lineWrap)}
                    title="Toggle line wrap"
                    style={{ backgroundColor: lineWrap ? 'var(--hover-bg, #e0e0e0)' : 'transparent' }}
                  >
                    ⤴
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <button
                      className="btn btn-icon btn-small"
                      onClick={() => setFontSize(Math.max(8, fontSize - 1))}
                      title="Decrease font size"
                    >
                      A-
                    </button>
                    <span style={{ fontSize: '12px', minWidth: '30px', textAlign: 'center', color: 'var(--text-color)' }}>
                      {fontSize}px
                    </span>
                    <button
                      className="btn btn-icon btn-small"
                      onClick={() => setFontSize(Math.min(20, fontSize + 1))}
                      title="Increase font size"
                    >
                      A+
                    </button>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-color)' }}>
                    <input
                      type="checkbox"
                      checked={autoScroll}
                      onChange={(e) => setAutoScroll(e.target.checked)}
                    />
                    Auto-scroll
                  </label>
                </div>
              </div>
            </div>
            <div
              ref={logMonitorContainerRef}
              className="output-content"
              style={{
                fontSize: `${fontSize}px`,
                whiteSpace: lineWrap ? 'pre-wrap' : 'pre',
              }}
            >
              {filteredLogMonitorLines.length === 0 ? (
                <div className="empty-state">
                  {isConnected
                    ? logMonitorLines.length === 0
                      ? 'Select log files to start tailing. Logs will appear here.'
                      : 'No logs match your filters.'
                    : 'Connect to view logs.'}
                </div>
              ) : (
                filteredLogMonitorLines.map((logLine, index) => {
                  const isHighlighted = searchResultIndex !== -1 && logMonitorMatches[searchResultIndex] === index;
                  const isBookmarked = bookmarks.some(b => b.line.line === logLine.line && b.line.file === logLine.file);
                  return (
                    <div
                      key={`monitor-${logLine.streamId}-${index}`}
                      className="log-line"
                      data-log-monitor-index={index}
                      style={{
                        backgroundColor: isHighlighted ? 'rgba(255, 235, 59, 0.2)' : 'transparent',
                      }}
                    >
                      {logLine.lineNumber && (
                        <span className="log-line-number">{logLine.lineNumber}</span>
                      )}
                      <span className="log-file-prefix">[{getFileName(logLine.file)}]</span>
                      <span className="log-line-text">
                        {highlightText(logLine.line, logMonitorSearchQuery, isHighlighted)}
                      </span>
                      <div className="log-line-actions">
                        <button
                          className="btn btn-icon btn-tiny"
                          onClick={() => handleCopyLine(logLine.line)}
                          title="Copy line"
                        >
                          📋
                        </button>
                        {!isBookmarked ? (
                          <button
                            className="btn btn-icon btn-tiny"
                            onClick={() => handleAddBookmark(logLine)}
                            title="Bookmark"
                          >
                            ⭐
                          </button>
                        ) : (
                          <button
                            className="btn btn-icon btn-tiny"
                            onClick={() => handleRemoveBookmark(bookmarks.find(b => b.line.line === logLine.line && b.line.file === logLine.file)?.id || '')}
                            title="Remove bookmark"
                          >
                            ★
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={logMonitorEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
