import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureHost } from '../src/host.mjs'
import { createLaunchHook } from '../src/launch-hook.mjs'
import { readWorkspaces } from '../src/orca-cli.mjs'
import { focusedPathOf, wslHostOf } from '../src/wsl-host.mjs'

test('a plugin folder WSL serves to Windows gives the home, the environment and /proc of its distro', async () => {
  const statOf = async (path) => {
    if (path === String.raw`\\wsl.localhost\Ubuntu\proc\42`) return {}
    throw new Error('ENOENT')
  }
  const wsl = wslHostOf(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo\orca-milestone`, { statOf })
  assert.equal(wsl.home, String.raw`\\wsl.localhost\Ubuntu\home\alice`)
  assert.equal(wsl.environment, 'Ubuntu (WSL)')
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

test('focusedPathOf finds the focused workspace by its id, else by its only match of name and branch', () => {
  const workspaces = [
    { id: 'a', name: 'main', branch: 'feature/x', path: '/repo-a' },
    { id: 'b', name: 'main', branch: 'feature/y', path: '/repo-b' },
    { id: 'c', name: 'main', branch: 'refs/heads/feature/y', path: '/repo-c' }
  ]
  assert.equal(focusedPathOf({ workspaceId: 'b', branch: 'feature/y', displayName: 'main' }, workspaces), '/repo-b')
  assert.equal(focusedPathOf({ workspaceId: 'zz', branch: 'feature/x', displayName: 'main' }, workspaces), '/repo-a')
  assert.equal(focusedPathOf({ branch: 'feature/y', displayName: 'main' }, workspaces), null)
})

test('readWorkspaces takes the focused workspace from the reader when Orca marks none active', async () => {
  const worktrees = [{ path: '/repo-a', displayName: 'a', isArchived: false, agents: [{ agentType: 'claude', state: 'done', paneKey: 't:l' }] }]
  const run = async () => ({ ok: true, result: { worktrees } })
  const read = await readWorkspaces('orca', run, { readFocusedPath: async () => '/repo-a' })
  assert.equal(read.active.path, '/repo-a')
  assert.equal(read.agents[0].focused, true)
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
