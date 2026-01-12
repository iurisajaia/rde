# Data Models

## Service
- name: string
- state: string
- extra: string

## LogStream
- id: string
- files: string[]
- mode: "last" | "follow"
- active: boolean

## CommandResult
- id: string
- command: string
- exitCode?: number
- startedAt: number
- endedAt?: number
