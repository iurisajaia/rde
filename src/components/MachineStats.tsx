import { useState, useEffect, useCallback } from 'react';
import './MachineStats.css';

interface MachineStatsData {
  cpu: { usedPct: number };
  memory: { totalKb: number; usedKb: number; availKb: number; usedPct: number };
  disk: { total: string; used: string; avail: string; usedPct: number };
  load: { avg1: number; avg5: number; avg15: number };
}

function fmtMem(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)}M`;
  return `${kb}K`;
}

function StatBar({ pct, warn = 70, danger = 90 }: { pct: number; warn?: number; danger?: number }) {
  const cls = pct >= danger ? 'stat-bar-fill danger' : pct >= warn ? 'stat-bar-fill warn' : 'stat-bar-fill ok';
  return (
    <div className="stat-bar">
      <div className={cls} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

const REFRESH_MS = 5000;

export function MachineStats() {
  const [stats, setStats] = useState<MachineStatsData | null>(null);
  const [error, setError] = useState(false);

  const fetch_ = useCallback(async () => {
    try {
      const r = await (window as any).electronAPI?.machineStats?.();
      if (r?.success) { setStats(r); setError(false); }
      else setError(true);
    } catch { setError(true); }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetch_]);

  if (error) return <div className="machine-stats machine-stats-error">⚠ Stats unavailable</div>;
  if (!stats) return <div className="machine-stats machine-stats-loading">Loading stats…</div>;

  const { cpu, memory, disk, load } = stats;

  return (
    <div className="machine-stats">
      <div className="stat-row">
        <span className="stat-label">CPU</span>
        <StatBar pct={cpu.usedPct} />
        <span className="stat-value">{cpu.usedPct.toFixed(1)}%</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">MEM</span>
        <StatBar pct={memory.usedPct} />
        <span className="stat-value">{fmtMem(memory.usedKb)} / {fmtMem(memory.totalKb)}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">DISK</span>
        <StatBar pct={disk.usedPct} warn={75} danger={90} />
        <span className="stat-value">{disk.used} / {disk.total}</span>
      </div>
      <div className="stat-row stat-row-load">
        <span className="stat-label">LOAD</span>
        <span className="stat-value-load">{load.avg1.toFixed(2)} · {load.avg5.toFixed(2)} · {load.avg15.toFixed(2)}</span>
      </div>
    </div>
  );
}
