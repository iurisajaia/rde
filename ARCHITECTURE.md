# Architecture

## High-level
- Electron Main = system layer
  - runs `rde ssh`
  - streams stdout/stderr
  - owns process lifecycle
- Renderer (React) = UI only
  - never spawns processes
  - communicates via IPC

Renderer MUST NOT:
- run shell commands
- access filesystem directly
- contain business logic for supervisor/logs

All remote command logic lives in Electron Main.

## Process model
- Each action spawns a new `rde ssh` process.
- Each log-follow action has its own long-lived process.
- Processes must be killable.

## Communication
- IPC is event-based.
- Streaming output is line-based.
