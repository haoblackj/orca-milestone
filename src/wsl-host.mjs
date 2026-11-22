// Orca for Windows runs plugin workers on Windows, also for the agents it runs in a WSL distro.
// Loaded from a folder WSL serves to Windows (\\wsl.localhost\<distro>\home\<user>\...), the plugin
// reads Claude's files and /proc through that share and asks the Orca CLI about the distro's
// environment. The worker's own home and processes are those of Windows and say nothing of them.
import { readdir, stat } from 'node:fs/promises'
import { join, win32 } from 'node:path'

const WSL_FOLDER = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\home\\([^\\]+)(?:\\|$)/i

/** The WSL distro a plugin folder lives in, or null when it is not a WSL share. */
export function wslHostOf(folder, { statOf = stat, pollMs = 3_000 } = {}) {
  const match = WSL_FOLDER.exec(folder ?? '')
  if (!match) return null
  const [, distro, user] = match
  const root = `\\\\wsl.localhost\\${distro}`
  return {
    home: win32.join(root, 'home', user),
    agentHome: `/home/${user}`,
    // Orca names the environment of a WSL distro after it, as `orca environment list` shows.
    environment: `${distro} (WSL)`,
    // How often the session files are read for a turn starting or ending (see statusPollMs of the worker).
    statusPollMs: 1_000,
    isRunning: async (pid) => Boolean(await statOf(win32.join(root, 'proc', String(pid))).catch(() => null)),
    // fs.watch throws EISDIR on a WSL share: Windows gets no change notices from it. So the folder
    // is polled: the names and times of what it holds, a task list's time moving when Claude renames
    // a task file into it. Only a difference is told, since a whole refresh reads many files over the share.
    watchDir: (dir, onChange) => {
      let last = null
      let timer = null
      let stopped = false
      const poll = async () => {
        const now = await stampOf(dir).catch(() => null)
        // Stopped while reading: no next poll.
        if (stopped) return
        if (last !== null && now !== last) onChange('change', dir)
        last = now
        timer = setTimeout(poll, pollMs)
      }
      timer = setTimeout(poll, 0)
      return () => {
        stopped = true
        clearTimeout(timer)
      }
    }
  }
}

async function stampOf(dir) {
  const names = (await readdir(dir)).sort()
  const times = await Promise.all(names.map(async (name) => (await stat(join(dir, name)).catch(() => null))?.mtimeMs))
  return names.map((name, index) => `${name}@${times[index]}`).join('\n')
}
