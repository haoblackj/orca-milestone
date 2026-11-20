// What differs when Orca for Windows runs the worker for agents in WSL (wsl-host.mjs): a process is
// looked up in WSL's /proc, and the launch hook adds nothing that runs on a Windows path.

const LOCAL = {
  isRunning: async (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return error.code === 'EPERM'
    }
  },
  /** The PermissionRequest hook and the Codex MCP server run on Orca's own binary. */
  permissionHook: true,
  codexProgress: true
}

let current = LOCAL

/** Replaces what differs from a local host; an empty object restores the local one. */
export function configureHost(overrides) {
  current = { ...LOCAL, ...overrides }
}

export function host() {
  return current
}
