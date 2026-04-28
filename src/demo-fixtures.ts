import type { Service } from './types';

/** Static demo data for the UI when no backend is attached. */
export const DEMO_SERVICES: Service[] = [
  {
    name: 'fundbox:web',
    state: 'RUNNING',
    extra: 'pid 1234',
    group: 'fundbox',
    program: 'web',
  },
  {
    name: 'fundbox:worker',
    state: 'STOPPED',
    extra: '',
    group: 'fundbox',
    program: 'worker',
  },
  {
    name: 'nginx',
    state: 'RUNNING',
    extra: 'pid 99',
    group: null,
    program: 'nginx',
  },
];

export const DEMO_LOG_FILES = [
  '/opt/fundbox/logs/demo-app.log',
  '/opt/fundbox/logs/demo-worker.log',
];

export const DEMO_VENVS: Record<string, string> = {
  fundbox_web: 'Python 3.11.6',
  fundbox_worker: 'Python 3.11.6',
};

export interface DemoDockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
}

export const DEMO_DOCKER_CONTAINERS: DemoDockerContainer[] = [
  {
    id: 'a1b2c3d4',
    name: 'postgres-demo',
    image: 'postgres:15',
    status: 'Up 2 hours',
    state: 'running',
    ports: '0.0.0.0:5432->5432/tcp',
    created: '2025-01-01',
  },
  {
    id: 'e5f6g7h8',
    name: 'redis-demo',
    image: 'redis:7-alpine',
    status: 'Exited (0) 1 day ago',
    state: 'exited',
    ports: '',
    created: '2025-01-02',
  },
];
