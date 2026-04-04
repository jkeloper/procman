# Plan B — Electron + node-pty Skeleton

**Purpose**: Fast-transition skeleton if Tauri(Plan A) fails S1/S4 Go/No-Go gate.

## Status
- 🟡 Dormant — Tauri(Plan A) is the primary track.
- Skeleton only: IPC ping-pong + node-pty import placeholder.
- node-pty native build is intentionally **not** approved (avoid wasted compilation during Week 0).

## Activate (if Plan B triggered)
```bash
pnpm approve-builds  # approve electron + node-pty
pnpm tsc
pnpm exec electron ./dist/main.js
```

## Files
- `main.ts` — Electron main process, IPC ping-pong, PTY placeholder
- `preload.ts` — contextBridge exposing `window.procman`
- `index.html` — minimal test UI

## Transition Trigger
See `/Users/jeonghwankim/projects/procman/docs/06-decision.md` §전환 트리거.
