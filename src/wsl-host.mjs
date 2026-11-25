// Orca for Windows runs plugin workers on Windows, also for the agents it runs in a WSL distro.
// Loaded from a folder WSL serves to Windows (\\wsl.localhost\<distro>\home\<user>\...), the plugin
// reads Claude's files and /proc through that share and asks the Orca CLI about the distro's
// environment. The worker's own home and processes are those of Windows and say nothing of them.
// Installed, the plugin lies on Windows and finds the distro through Orca. That is the way to run it:
// Orca cannot watch a development folder on a WSL share. Its watch starts and then fails, Orca starts
// it again every 60 s, and each start counts as a change of the plugin and loads the panel anew, which blinks.
import { readdir, stat } from 'node:fs/promises'
import { join, win32 } from 'node:path'

const WSL_FOLDER = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\home\\([^\\]+)(?:\\|$)/i

/** The WSL distro a plugin folder lives in, or null when it is not a WSL share. */
export function wslHostOf(folder, options) {
  const match = WSL_FOLDER.exec(folder ?? '')
  if (!match) return null
  const [, distro, user] = match
  // Orca names the environment of a WSL distro after it, as `orca environment list` shows.
  return hostIn(distro, user, `${distro} (WSL)`, options)
}

// What says that a home has nothing for the plugin, unlike an error of the moment.
const NOT_MINE = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'])
const AGENT_FOLDERS = ['.claude', '.codex']

/**
 * The WSL distro the plugin runs for: the one its folder lives in, else, installed on Windows, the
 * first Orca has an environment of with a home Claude or Codex uses. Null when there is none, and for
 * a machine other than Windows. Throws when Orca does not answer, or when none was found and one
 * could not be read: WSL may still be booting, and null would stand until the worker ends.
 * @param listEnvironments the reply of `orca environment list --json`
 */
export async function findWslHost(folder, { platform = process.platform, listEnvironments, readNames = readdir, readMs = 5_000, ...options }) {
  const served = wslHostOf(folder, options)
  if (served || platform !== 'win32') return served
  const response = await listEnvironments()
  if (!response?.ok) throw new Error(response?.error?.message ?? 'orca environment list failed')
  let unreadable = null
  for (const { id, orcadDeployment } of response.result?.environments ?? []) {
    if (orcadDeployment?.kind !== 'wsl') continue
    const { distro } = orcadDeployment
    const homes = win32.join(rootOf(distro), 'home')
    try {
      for (const user of await within(readMs, readNames(homes), homes)) {
        const home = win32.join(homes, user)
        const names = await within(readMs, readNames(home), home).catch((error) => {
          if (NOT_MINE.has(error.code)) return []
          throw error
        })
        if (AGENT_FOLDERS.some((name) => names.includes(name))) return hostIn(distro, user, id, options)
      }
    } catch (error) {
      unreadable = error
    }
  }
  if (unreadable) throw unreadable
  return null
}

function within(ms, promise, what) {
  let timer
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

function rootOf(distro) {
  return `\\\\wsl.localhost\\${distro}`
}

function hostIn(distro, user, environment, { statOf = stat, pollMs = 3_000 } = {}) {
  const root = rootOf(distro)
  return {
    home: win32.join(root, 'home', user),
    agentHome: `/home/${user}`,
    environment,
    // How often the session files are read for a turn starting or ending (see statusPollMs of the worker).
    statusPollMs: 1_000,
    // The settings name the daemon of another Mac. Reading them needs settings:own, which the manifest does not ask for.
    readSettings: async () => ({}),
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
