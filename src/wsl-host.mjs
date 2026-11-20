// Orca for Windows runs plugin workers on Windows, also for the agents it runs in a WSL distro.
// Loaded from a folder WSL serves to Windows (\\wsl.localhost\<distro>\home\<user>\...), the plugin
// reads Claude's files and /proc through that share and asks the Orca CLI about the distro's
// environment. The worker's own home and processes are those of Windows and say nothing of them.
import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'

const WSL_FOLDER = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\home\\([^\\]+)(?:\\|$)/i

/** The WSL distro a plugin folder lives in, or null when it is not a WSL share. */
export function wslHostOf(folder, { statOf = stat } = {}) {
  const match = WSL_FOLDER.exec(folder ?? '')
  if (!match) return null
  const [, distro, user] = match
  const root = `\\\\wsl.localhost\\${distro}`
  return {
    home: win32.join(root, 'home', user),
    // Orca names the environment of a WSL distro after it, as `orca environment list` shows.
    environment: `${distro} (WSL)`,
    isRunning: async (pid) => Boolean(await statOf(win32.join(root, 'proc', String(pid))).catch(() => null))
  }
}

const branchName = (branch) => String(branch ?? '').replace(/^refs\/heads\//, '')

/**
 * The path of the focused workspace. `orca worktree ps --environment` marks none active, so the
 * focus comes from the host API: the workspace with the id `workspace.readContext` gives, else
 * the only one with its name and branch. Null when it cannot be told.
 * @param context what `workspace.readContext` answers
 * @param workspaces the rows of `workspace.list`
 */
export function focusedPathOf(context, workspaces) {
  if (!context) return null
  const byId = context.workspaceId ? workspaces.find((workspace) => workspace.id === context.workspaceId) : null
  if (byId) return byId.path
  const named = workspaces.filter(
    (workspace) => workspace.name === context.displayName && branchName(workspace.branch) === branchName(context.branch)
  )
  return named.length === 1 ? named[0].path : null
}
