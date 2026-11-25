import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureHost } from '../src/host.mjs'
import { createLaunchHook } from '../src/launch-hook.mjs'
import { cliEnv, readWorkspaces } from '../src/orca-cli.mjs'
import { whereOf } from '../src/risk.mjs'
import { findWslHost, wslHostOf } from '../src/wsl-host.mjs'

test('a plugin folder WSL serves to Windows gives the home, the environment and /proc of its distro', async () => {
  const statOf = async (path) => {
    if (path === String.raw`\\wsl.localhost\Ubuntu\proc\42`) return {}
    throw new Error('ENOENT')
  }
  const wsl = wslHostOf(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo\orca-milestone`, { statOf })
  assert.equal(wsl.home, String.raw`\\wsl.localhost\Ubuntu\home\alice`)
  assert.equal(wsl.environment, 'Ubuntu (WSL)')
  assert.equal(wsl.agentHome, '/home/alice')
  // Orca sends no agent event for agents in WSL, so a turn's end is seen in the session files at this pace.
  assert.equal(wsl.statusPollMs, 1_000)
  assert.equal(await wsl.isRunning(42), true)
  assert.equal(await wsl.isRunning(43), false)
  assert.equal(wslHostOf('/Users/alice/orca-milestone'), null)
})

const ENVIRONMENTS = [
  { id: 'b1', name: 'build box', endpoints: [] },
  { id: 'wsl:empty', name: 'Empty (WSL)', orcadDeployment: { kind: 'wsl', distro: 'Empty' } },
  { id: 'wsl:ubuntu', name: 'Ubuntu (WSL)', orcadDeployment: { kind: 'wsl', distro: 'Ubuntu' } }
]
const INSTALLED = String.raw`C:\Users\alice\AppData\Roaming\orca\plugins\andoshin11.milestone`
const FILES = {
  [String.raw`\\wsl.localhost\Empty\home`]: ['alice'],
  [String.raw`\\wsl.localhost\Empty\home\alice`]: ['.bashrc'],
  [String.raw`\\wsl.localhost\Ubuntu\home`]: ['nobody', 'alice'],
  [String.raw`\\wsl.localhost\Ubuntu\home\nobody`]: [],
  [String.raw`\\wsl.localhost\Ubuntu\home\alice`]: ['.claude']
}
const readNames = async (dir) => {
  if (!FILES[dir]) throw new Error('ENOENT')
  return FILES[dir]
}
const listing = (environments) => async () => ({ ok: true, result: { environments } })

test('installed on Windows, the plugin finds the distro Orca runs and the home in it that Claude uses', async () => {
  const wsl = await findWslHost(INSTALLED, { platform: 'win32', listEnvironments: listing(ENVIRONMENTS), readNames })
  // The id stays when the environment is renamed.
  assert.equal(wsl.environment, 'wsl:ubuntu')
  assert.equal(wsl.home, String.raw`\\wsl.localhost\Ubuntu\home\alice`)
  assert.equal(wsl.agentHome, '/home/alice')
})

test('a folder WSL serves names its distro by itself, and no other machine asks for one', async () => {
  const listEnvironments = () => assert.fail('must not ask Orca')
  const served = await findWslHost(String.raw`\\wsl.localhost\Debian\home\bob\orca-milestone`, { platform: 'win32', listEnvironments, readNames })
  assert.equal(served.environment, 'Debian (WSL)')
  assert.equal(await findWslHost('/Users/alice/orca-milestone', { platform: 'darwin', listEnvironments, readNames }), null)
})

test('installed on Windows without a distro that has agents, the plugin runs for those of Windows', async () => {
  const find = (environments) => findWslHost(INSTALLED, { platform: 'win32', listEnvironments: listing(environments), readNames })
  assert.equal(await find([]), null)
  assert.equal(await find(ENVIRONMENTS.slice(0, 2)), null)
})

// Taken for a Windows without WSL, it would show nothing of the agents until the next start of the worker.
test('the search fails when Orca does not say which environments it has, or the only distro cannot be read', async () => {
  const failing = { platform: 'win32', readNames }
  await assert.rejects(findWslHost(INSTALLED, { ...failing, listEnvironments: async () => { throw new Error('runtime_unavailable') } }), /runtime_unavailable/)
  await assert.rejects(findWslHost(INSTALLED, { ...failing, listEnvironments: async () => ({ ok: false, error: { message: 'no runtime' } }) }), /no runtime/)
  const stopped = { id: 'wsl:stopped', name: 'Stopped (WSL)', orcadDeployment: { kind: 'wsl', distro: 'Stopped' } }
  await assert.rejects(findWslHost(INSTALLED, { ...failing, listEnvironments: listing([stopped]) }), /ENOENT/)
  const found = await findWslHost(INSTALLED, { ...failing, listEnvironments: listing([stopped, ...ENVIRONMENTS]) })
  assert.equal(found.environment, 'wsl:ubuntu')
})

test('the search fails, and does not take the agents for those of Windows, when a home cannot be read for the moment', async () => {
  const failsWith = (code) => async (dir) => {
    if (dir.endsWith('alice')) throw Object.assign(new Error(code), { code })
    return readNames(dir)
  }
  const find = (code) => findWslHost(INSTALLED, { platform: 'win32', listEnvironments: listing(ENVIRONMENTS.slice(2)), readNames: failsWith(code) })
  await assert.rejects(find('EIO'), /EIO/)
  assert.equal(await find('EACCES'), null, 'the home of someone else')
})

test('the search fails when the share does not answer in time', async () => {
  const pending = () => new Promise(() => {})
  await assert.rejects(findWslHost(INSTALLED, { platform: 'win32', listEnvironments: listing(ENVIRONMENTS), readNames: pending, readMs: 5 }), /did not answer/)
})

test('installed on Windows, the plugin takes a home only Codex uses too', async () => {
  const names = async (dir) => (dir.endsWith('home') ? ['alice'] : ['.codex'])
  const wsl = await findWslHost(INSTALLED, { platform: 'win32', listEnvironments: listing(ENVIRONMENTS), readNames: names })
  assert.equal(wsl.agentHome, '/home/alice')
})

// Orca stops a plugin whose new version asks for more until a person allows it.
test('the plugin asks for no access to settings, and a WSL host reads none', async () => {
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.capabilities.map(({ kind }) => kind), ['workspace:read', 'agent:read', 'workspace:write'])
  assert.equal(manifest.contributes.settings, undefined)
  const wsl = wslHostOf(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo\orca-milestone`)
  assert.deepEqual(await wsl.readSettings(), {})
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
