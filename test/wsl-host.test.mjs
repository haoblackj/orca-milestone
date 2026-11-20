import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureHost } from '../src/host.mjs'
import { createLaunchHook } from '../src/launch-hook.mjs'
import { cliEnv, readWorkspaces } from '../src/orca-cli.mjs'
import { whereOf } from '../src/risk.mjs'
import { wslHostOf } from '../src/wsl-host.mjs'

test('a plugin folder WSL serves to Windows gives the home, the environment and /proc of its distro', async () => {
  const statOf = async (path) => {
    if (path === String.raw`\\wsl.localhost\Ubuntu\proc\42`) return {}
    throw new Error('ENOENT')
  }
  const wsl = wslHostOf(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo\orca-milestone`, { statOf })
  assert.equal(wsl.home, String.raw`\\wsl.localhost\Ubuntu\home\alice`)
  assert.equal(wsl.environment, 'Ubuntu (WSL)')
  assert.equal(wsl.agentHome, '/home/alice')
  assert.equal(await wsl.isRunning(42), true)
  assert.equal(await wsl.isRunning(43), false)
  assert.equal(wslHostOf('/Users/alice/orca-milestone'), null)
})

test('a WSL host polls a folder instead of watching it, and tells a change only when a list in it changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-milestone-poll-'))
  await mkdir(join(dir, 'list-a'))
  const wsl = wslHostOf(String.raw`\\wsl.localhost\Ubuntu\home\alice\p`, { pollMs: 5 })
  const names = []
  const stop = wsl.watchDir(dir, (_event, name) => names.push(name))
  const pause = () => new Promise((resolve) => setTimeout(resolve, 40))
  await pause()
  assert.deepEqual(names, [])
  await mkdir(join(dir, 'list-b'))
  await pause()
  // The worker skips a change without a name.
  assert.ok(names.length === 1 && typeof names[0] === 'string' && names[0].length > 0)
  stop()
})

test('on Windows the Orca CLI gets APPDATA and LOCALAPPDATA, which Orca leaves out of a worker', () => {
  const env = cliEnv({ PATH: 'p' }, 'win32', String.raw`C:\Users\alice`)
  assert.equal(env.APPDATA, String.raw`C:\Users\alice\AppData\Roaming`)
  assert.equal(env.LOCALAPPDATA, String.raw`C:\Users\alice\AppData\Local`)
  assert.equal(env.PATH, 'p')
  assert.equal(cliEnv({ APPDATA: 'x' }, 'win32', 'C:\\h').APPDATA, 'x')
  assert.equal(cliEnv({}, 'darwin', '/Users/alice').APPDATA, undefined)
})

test('readWorkspaces takes the focused workspace by the id the host API gives when Orca marks none active', async () => {
  const worktrees = [{ worktreeId: 'r::/repo-a', path: '/repo-a', displayName: 'a', isArchived: false, agents: [{ agentType: 'claude', state: 'done', paneKey: 't:l' }] }]
  const run = async () => ({ ok: true, result: { worktrees } })
  const read = await readWorkspaces('orca', run, { readFocusedId: async () => 'r::/repo-a' })
  assert.equal(read.active.path, '/repo-a')
  assert.equal(read.agents[0].focused, true)
})

test('on a WSL host a permission card says where a command runs with the home of the distro', () => {
  configureHost({ agentHome: '/home/alice' })
  try {
    assert.equal(whereOf({ input: { command: 'cd /home/alice/notes && ls' } }, '/home/alice/ws'), '~/notes')
    assert.equal(whereOf({ input: { command: 'cd apps/web && ls' } }, '/home/alice/ws'), 'apps/web')
  } finally {
    configureHost({})
  }
})

test('on a WSL host the launch hook adds no Windows paths: no permission hook, no Codex tool', () => {
  configureHost({ permissionHook: false, codexProgress: false })
  try {
    const hook = createLaunchHook({ execPath: 'C:\\Orca.exe', serverPath: 'C:\\p\\progress-server.mjs' })
    const claude = hook({ agent: 'claude', command: 'claude', env: {} }, (event) => event)
    assert.match(claude.command, /--append-system-prompt '/)
    assert.doesNotMatch(claude.command, /--settings/)
    assert.equal(claude.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1')
    assert.equal(hook({ agent: 'codex', command: 'codex', env: {} }, (event) => event), undefined)
  } finally {
    configureHost({})
  }
})
