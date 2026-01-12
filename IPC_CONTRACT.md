# IPC Contract

## Renderer → Main

- rde/connect
  { target: string }

- rde/disconnect
  {}

- supervisor/status
  { target: string }

- supervisor/restart
  { target: string, serviceName: string }

- logs/list
  { target: string }

- logs/tail
  {
    target: string,
    files: string[],
    mode: "last" | "follow",
    lines?: number
  }

- logs/stop
  { streamId: string }

## Main → Renderer (events)

- rde/status
  { state, message? }

- supervisor/statusResult
  { services }

- command/output
  { id, source, text }

- logs/line
  { streamId, file, line }

- logs/stopped
  { streamId, reason, message? }
