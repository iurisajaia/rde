# Remote Commands

## Supervisor
- Status:
  sudo supervisorctl status

- Restart:
  sudo supervisorctl restart <serviceName>

## Logs
- List:
  ls -1 /opt/fundbox/logs/*.log 2>/dev/null || true

- Last N lines:
  tail -n 200 <file>

- Follow:
  tail -F <file>

All commands are executed via:
  rde ssh <target> "<command>"
