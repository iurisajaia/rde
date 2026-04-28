# Cursor Prompts

## General rules
- Do not introduce Rust or Tauri.
- Do not introduce SSH libraries.
- Use child_process.spawn only.
- Use TypeScript.

## When working in Electron Main
- Never import React code.
- Always stream stdout/stderr.
- Always return structured results.

## When working in Renderer
- No shell access.
- No filesystem access.
- All side effects go through IPC.
