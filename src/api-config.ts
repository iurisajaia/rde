/** Same-origin prefix for the Express API behind nginx (maps to /api/ on Node). */
function apiBaseUrl(): string {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim().replace(/\/$/, '');
    // Legacy mistake: /api hits the UI origin with no proxy; use /rde-api (or /rde-ui/api).
    if (t === '/api') return '/rde-api';
    return t;
  }
  return '/rde-api';
}

export const API_BASE_URL = apiBaseUrl();
