import assert from 'node:assert/strict'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMilestoneWorker } from '../src/milestone-worker.mjs'
import { SESSION_A, SESSION_B, makeHome, markRunning, task, taskCalls, writeTasks, writeTranscript } from './helpers.mjs'

function fakeOrca() {
  const posts = []
  return {
    log: () => {},
    panels: { post: (event, payload) => posts.push({ event, payload }) },
    posts,
    shown: () => posts.at(-1).payload.html
  }
}

test('refresh posts the focused workspace tasks to the panel', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Build milestones' })
  await writeTasks(home, SESSION_A, [task(1, 'Read spec', 'completed'), task(2, 'Write code', 'in_progress')])
  await writeTranscript(home, SESSION_B, { cwd: '/work/other', prompt: 'Something else' })
  await writeTasks(home, SESSION_B, [task(1, 'Unrelated', 'pending')])

  let cliCalls = 0
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => {
      cliCalls += 1
      return { active: { path: '/work/app', displayName: 'app', agentStates: ['working'] }, agents: [] }
    },
    watchDir: () => {}
  })

  await worker.refresh(true)
  const first = orca.shown()
  assert.ok(first.includes('Build milestones'))
  assert.ok(first.includes('1 / 2'))
  assert.ok(!first.includes('Unrelated'))

  await writeTasks(home, SESSION_A, [task(2, 'Write code', 'completed'), task(3, 'Run tests', 'in_progress')])
  await worker.refresh()
  const second = orca.shown()
  assert.ok(second.includes('2 / 3'))
  assert.equal(cliCalls, 1, 'a task change alone does not ask the CLI again')
})

test('a list Claude deletes after finishing stays on screen as done; a cleared unfinished one goes', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Finish me' })
  await writeTranscript(home, SESSION_B, { cwd: '/work/app', prompt: 'Abandon me' })
  const doneDir = await writeTasks(home, SESSION_A, [task(1, 'Only step', 'completed')])
  const clearedDir = await writeTasks(home, SESSION_B, [task(1, 'Half step', 'in_progress')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  await rm(join(doneDir, '1.json'))
  await rm(join(clearedDir, '1.json'))
  await worker.refresh()
  const html = orca.shown()
  assert.ok(html.includes('Finish me'))
  assert.ok(html.includes('1 / 1'))
  assert.ok(!html.includes('Abandon me'))
})

test('a team lead\'s list, named session-<id prefix>, shows under its workspace', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Team goal' })
  await writeTasks(home, 'session-11111111', [task(1, 'Plan', 'completed'), task(2, 'Build', 'pending')])
  await writeTasks(home, 'session-22222222', [])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  const html = orca.shown()
  assert.ok(html.includes('Team goal'))
  assert.ok(html.includes('1 / 2'))
})

test('the heading follows the goal of the current tasks, not the first prompt of the session', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'First goal' })
  const transcript = join(home, '.claude', 'projects', '-work-app', `${SESSION_A}.jsonl`)
  await appendFile(
    transcript,
    [
      { type: 'user', cwd: '/work/app', message: { role: 'user', content: 'Second goal' } },
      { type: 'assistant', cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'Step two' } }] } }
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
  )
  await writeTasks(home, SESSION_A, [task(1, 'Step two', 'pending')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  let html = orca.shown()
  assert.ok(html.includes('Second goal'))
  assert.ok(!html.includes('First goal'))

  await writeTasks(home, SESSION_A, [
    task(1, 'Step two', 'completed'),
    task(2, 'Step three', 'pending', { metadata: { goal: 'Goal Claude wrote' } })
  ])
  await worker.refresh()
  html = orca.shown()
  assert.ok(html.includes('Goal Claude wrote'))
  assert.ok(html.includes('0 / 1'), 'tasks of the earlier goal are left out')
  assert.ok(!html.includes('Step two'))
})

test('a finished list comes back from the transcript after a restart, and goes with its session', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, {
    cwd: '/work/done',
    prompt: 'Do it',
    running: false,
    extra: taskCalls(
      [{ subject: 'Old step' }, { subject: 'New step', metadata: { goal: 'Second goal' } }],
      [{ taskId: '1', status: 'completed' }, { taskId: '2', status: 'completed' }]
    )
  })
  const running = await markRunning(home, SESSION_A)
  // Claude deleted the files of the finished list; only its high-water mark is left.
  const dir = await writeTasks(home, SESSION_A, [])
  await writeFile(join(dir, '.highwatermark'), '2')
  const options = {
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: [] },
      agents: [{ workspace: 'done', path: '/work/done', focused: false, state: 'done', since: 0 }]
    }),
    watchDir: () => {}
  }
  const worker = createMilestoneWorker(options)
  await worker.refresh(true)
  let html = orca.shown()
  assert.ok(html.includes('<span class="name">done</span>'))
  // Only the tasks of the newest goal show.
  assert.ok(html.includes('1 / 1'))
  assert.ok(html.includes('Second goal'))

  await rm(running)
  await worker.refresh()
  html = orca.shown()
  assert.ok(!html.includes('<span class="name">done</span>'), 'gone once the session ends')
})

test('a failing CLI leaves the panel showing that no workspace is known', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const logs = []
  orca.log = (line) => logs.push(line)
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => {
      throw new Error('runtime unavailable')
    },
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.ok(orca.shown().includes('ワークスペースを開くと'))
  assert.match(logs.join('\n'), /runtime unavailable/)
})

test('a refresh posts only a real change, at once', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'App goal' })
  await writeTasks(home, SESSION_A, [task(1, 'One', 'pending'), task(2, 'Two', 'pending')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.equal(orca.posts.length, 1)
  assert.equal(orca.posts[0].event, 'view.changed')

  await worker.refresh(true)
  assert.equal(orca.posts.length, 1, 'the same view is not posted again')

  await writeTasks(home, SESSION_A, [task(1, 'One', 'completed')])
  await worker.refresh()
  assert.equal(orca.posts.length, 2)
  assert.ok(orca.shown().includes('1 / 2'))
})

test('view answers with what the panel should show, even when Orca could not be read', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timers.push(timer)
    return timer
  }
  try {
    const worker = createMilestoneWorker({
      orca,
      home,
      cli: 'orca',
      readOrca: async () => {
        throw new Error('runtime unavailable')
      },
      watchDir: () => {}
    })
    const { html } = await worker.view()
    assert.ok(html.includes('ワークスペースを開くと'))
    assert.equal(timers.length, 1, 'one slow sync; the rest is driven by events')
  } finally {
    globalThis.setInterval = realSetInterval
    timers.forEach(clearInterval)
  }
})

test('an agent event asks Orca again only when that pane changed state', async () => {
  const home = await makeHome()
  let asked = 0
  const worker = createMilestoneWorker({
    orca: fakeOrca(),
    home,
    cli: 'orca',
    readOrca: async () => {
      asked += 1
      return { active: null, agents: [] }
    },
    watchDir: () => {}
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

  worker.agentChanged({ paneKey: 'a', state: 'working' })
  await settle()
  assert.equal(asked, 1)

  worker.agentChanged({ paneKey: 'a', state: 'working' })
  await settle()
  assert.equal(asked, 1, 'the same state again')

  worker.agentChanged({ paneKey: 'a', state: 'waiting' })
  worker.agentChanged({ paneKey: 'b', state: 'working' })
  await settle()
  assert.equal(asked, 2, 'changes close together make one refresh')

  worker.agentChanged({ paneKey: 'b', state: 'working', mainAgent: { state: 'waiting' } })
  await settle()
  assert.equal(asked, 3, 'the main agent of a pane counts too')
})

test('openWorkspace opens the listed workspace at the path, and only logs a miss or a failure', async () => {
  const orca = fakeOrca()
  const logs = []
  orca.log = (line) => logs.push(line)
  const calls = []
  let fail = false
  orca.host = {
    call: async (method, params) => {
      calls.push([method, params])
      if (fail) throw new Error('refused')
      return {
        workspaces: [
          { id: 'identity:a', path: '/work/a' },
          { id: 'identity:b', path: '/work/b' }
        ]
      }
    }
  }
  const runCli = async () => ({ ok: true, result: { terminals: [] } })
  const worker = createMilestoneWorker({ orca, home: await makeHome(), cli: 'orca', runCli, watchDir: () => {} })

  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: true })
  assert.deepEqual(calls.at(-1), ['workspace.open', { workspaceId: 'identity:b' }])

  calls.length = 0
  assert.deepEqual(await worker.openWorkspace('/work/gone'), { opened: false })
  assert.deepEqual(calls.map(([method]) => method), ['workspace.list'])
  assert.match(logs.join('\n'), /no workspace to open at \/work\/gone/)

  fail = true
  assert.deepEqual(await worker.openWorkspace('/work/a'), { opened: false })
  assert.match(logs.join('\n'), /could not open the workspace: refused/)
})

// Orca for Windows runs the worker on Windows, and its workspace.list holds none of the workspaces of
// a WSL distro. The Orca CLI, asked about that environment, switches the desktop to one of its terminals.
test('openWorkspace switches to the agent terminal of a workspace the host does not list', async () => {
  const orca = fakeOrca()
  const logs = []
  orca.log = (line) => logs.push(line)
  orca.host = { call: async () => ({ workspaces: [] }) }
  const asked = []
  const terminals = [
    { handle: 'term_other', worktreePath: '/work/other', agentIdentity: 'claude', lastOutputAt: 9 },
    { handle: 'term_shell', worktreePath: '/work/b', lastOutputAt: 8 },
    { handle: 'term_old', worktreePath: '/work/b', agentIdentity: 'claude', lastOutputAt: 3 },
    { handle: 'term_new', worktreePath: '/work/b', agentIdentity: 'codex', lastOutputAt: 5 }
  ]
  let navigated = true
  const runCli = async (cli, args) => {
    asked.push(args)
    if (args[0] === 'terminal' && args[1] === 'list') return { ok: true, result: { terminals } }
    if (args[0] === 'terminal' && args[1] === 'switch') return { ok: true, result: { focus: { handle: args[3], navigated } } }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  const worker = createMilestoneWorker({ orca, home: await makeHome(), cli: 'orca', runCli, watchDir: () => {} })

  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: true })
  assert.deepEqual(asked.at(-1), ['terminal', 'switch', '--terminal', 'term_new', '--json'], 'the agent terminal that printed last')

  terminals.splice(2, 2)
  asked.length = 0
  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: true })
  assert.deepEqual(asked.at(-1), ['terminal', 'switch', '--terminal', 'term_shell', '--json'], 'any terminal of it, without an agent')

  navigated = false
  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: false })

  asked.length = 0
  assert.deepEqual(await worker.openWorkspace('/work/gone'), { opened: false })
  assert.deepEqual(asked, [['terminal', 'list', '--json']])
  assert.match(logs.join('\n'), /no workspace to open at \/work\/gone/)
})

// Each CLI call costs 0.45-0.7 s from the worker under Orca for Windows: a press that first lists the
// terminals takes 1.15 s to switch. The list is read after each refresh instead, off the press.
test('openWorkspace switches at once to a terminal listed after the last refresh', async () => {
  const orca = fakeOrca()
  orca.host = { call: async () => ({ workspaces: [] }) }
  const asked = []
  let terminals = [{ handle: 'term_b', worktreePath: '/work/b', agentIdentity: 'claude', lastOutputAt: 1 }]
  const gone = new Set()
  const runCli = async (cli, args) => {
    asked.push(args)
    if (args[1] === 'list') return { ok: true, result: { terminals } }
    if (gone.has(args[3])) throw new Error('terminal_handle_stale')
    return { ok: true, result: { focus: { handle: args[3], navigated: true } } }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const readOrca = async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] })
  const worker = createMilestoneWorker({ orca, home: await makeHome(), cli: 'orca', runCli, readOrca, prefetchTerminals: true, watchDir: () => {} })

  await worker.refresh(true)
  await settle()
  assert.deepEqual(asked, [['terminal', 'list', '--json']], 'listed once, after the refresh')

  asked.length = 0
  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: true })
  assert.deepEqual(asked, [['terminal', 'switch', '--terminal', 'term_b', '--json']], 'only the switch on a press')

  gone.add('term_b')
  terminals = [{ handle: 'term_b2', worktreePath: '/work/b', agentIdentity: 'claude', lastOutputAt: 2 }]
  asked.length = 0
  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: true })
  assert.deepEqual(
    asked,
    [
      ['terminal', 'switch', '--terminal', 'term_b', '--json'],
      ['terminal', 'list', '--json'],
      ['terminal', 'switch', '--terminal', 'term_b2', '--json']
    ],
    'a stale handle lists the terminals again'
  )
})

test('a slow listing of the terminals holds no refresh back, runs one at a time, and an older one never wins', async () => {
  const orca = fakeOrca()
  orca.host = { call: async () => ({ workspaces: [] }) }
  const asked = []
  const pending = []
  const runCli = async (cli, args) => {
    asked.push(args)
    if (args[1] === 'list') return new Promise((resolve) => pending.push(resolve))
    return { ok: true, result: { focus: { handle: args[3], navigated: true } } }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const readOrca = async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] })
  const worker = createMilestoneWorker({ orca, home: await makeHome(), cli: 'orca', runCli, readOrca, prefetchTerminals: true, watchDir: () => {} })

  await worker.refresh(true)
  await worker.refresh(true)
  assert.equal(orca.posts.length > 0, true, 'the refreshes published while the listing hangs')
  assert.equal(asked.filter((args) => args[1] === 'list').length, 1, 'one listing at a time')

  // A press lists anew while the background listing still hangs; the newer one answers first.
  const pressed = worker.openWorkspace('/work/b')
  await settle()
  pending[1]({ ok: true, result: { terminals: [{ handle: 'term_new', worktreePath: '/work/b', agentIdentity: 'claude' }] } })
  assert.deepEqual(await pressed, { opened: true })
  pending[0]({ ok: true, result: { terminals: [{ handle: 'term_old', worktreePath: '/work/b', agentIdentity: 'claude' }] } })
  await settle()

  asked.length = 0
  await worker.openWorkspace('/work/b')
  assert.deepEqual(asked, [['terminal', 'switch', '--terminal', 'term_new', '--json']], 'the listing that started later is kept')
})

test('a refresh lists no terminals unless asked to', async () => {
  const orca = fakeOrca()
  const asked = []
  const runCli = async (cli, args) => {
    asked.push(args)
    return { ok: true, result: { terminals: [] } }
  }
  const readOrca = async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] })
  const worker = createMilestoneWorker({ orca, home: await makeHome(), cli: 'orca', runCli, readOrca, watchDir: () => {} })

  await worker.refresh(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(asked, [])
})

// Orca for Windows sends no agent.status.changed for agents in WSL, so what a turn's end shows in
// Claude's session file is what tells the worker to ask Orca again.
test('a Claude session turning busy or idle asks Orca again; nothing changing does not', async () => {
  const home = await makeHome()
  const sessionFile = await markRunning(home, SESSION_A)
  const setStatus = (status, at) => writeFile(sessionFile, JSON.stringify({ pid: process.pid, sessionId: SESSION_A, cwd: '/work/app', status, statusUpdatedAt: at }))
  await setStatus('busy', 1)
  let asked = 0
  const worker = createMilestoneWorker({
    orca: fakeOrca(),
    home,
    cli: 'orca',
    statusPollMs: 10,
    readOrca: async () => {
      asked += 1
      return { active: null, agents: [] }
    },
    watchDir: () => {}
  })
  const until = async (done) => {
    for (let waited = 0; waited < 3000 && !done(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timers.push(timer)
    return timer
  }
  try {
    await worker.start()
    assert.equal(asked, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(asked, 1, 'an unchanged status is not a reason to ask')

    await setStatus('idle', 2)
    await until(() => asked > 1)
    assert.equal(asked, 2, 'the turn ended: Orca is asked')
  } finally {
    globalThis.setInterval = realSetInterval
    timers.forEach(clearInterval)
  }
})

test('the plugin log gets no trace lines unless trace is on', async () => {
  const home = await makeHome()
  const lines = []
  const worker = createMilestoneWorker({
    orca: { ...fakeOrca(), log: (line) => lines.push(line) },
    home,
    cli: 'orca',
    readOrca: async () => ({ active: null, agents: [] }),
    watchDir: () => {}
  })
  worker.agentChanged({ paneKey: 'tab:leaf', state: 'done', mainAgent: { state: 'done' } })
  await worker.refresh(true)
  assert.deepEqual(lines, [])
})

test('without statusPollMs the session files are not watched', async () => {
  const home = await makeHome()
  const sessionFile = await markRunning(home, SESSION_A)
  const setStatus = (status, at) => writeFile(sessionFile, JSON.stringify({ pid: process.pid, sessionId: SESSION_A, cwd: '/work/app', status, statusUpdatedAt: at }))
  await setStatus('busy', 1)
  let asked = 0
  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timers.push(timer)
    return timer
  }
  try {
    const worker = createMilestoneWorker({
      orca: fakeOrca(),
      home,
      cli: 'orca',
      readOrca: async () => {
        asked += 1
        return { active: null, agents: [] }
      },
      watchDir: () => {}
    })
    await worker.start()
    await setStatus('idle', 2)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(asked, 1)
  } finally {
    globalThis.setInterval = realSetInterval
    timers.forEach(clearInterval)
  }
})

test('the watch of the session files goes on when the log throws, and a session that appears asks Orca too', async () => {
  const home = await makeHome()
  const sessionFile = await markRunning(home, SESSION_A)
  const setStatus = (file, id, status, at) => writeFile(file, JSON.stringify({ pid: process.pid, sessionId: id, cwd: '/work/app', status, statusUpdatedAt: at }))
  await setStatus(sessionFile, SESSION_A, 'busy', 1)
  let asked = 0
  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timers.push(timer)
    return timer
  }
  try {
    const worker = createMilestoneWorker({
      orca: {
        ...fakeOrca(),
        log: () => {
          throw new Error('log is gone')
        }
      },
      home,
      cli: 'orca',
      readSettings: async () => ({}),
      trace: true,
      statusPollMs: 10,
      readOrca: async () => {
        asked += 1
        return { active: null, agents: [] }
      },
      watchDir: () => {}
    })
    const until = async (done) => {
      for (let waited = 0; waited < 3000 && !done(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await worker.start()
    await setStatus(sessionFile, SESSION_A, 'idle', 2)
    await until(() => asked > 1)
    assert.equal(asked, 2)

    const second = await markRunning(home, SESSION_B)
    await setStatus(second, SESSION_B, 'busy', 3)
    await until(() => asked > 2)
    assert.equal(asked, 3)
  } finally {
    globalThis.setInterval = realSetInterval
    timers.forEach(clearInterval)
  }
})

test('trace lines tell when an event arrived, what asked for a refresh, and how long each part took', async () => {
  const home = await makeHome()
  const lines = []
  const orca = { ...fakeOrca(), log: (line) => lines.push(line) }
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Trace me' })
  await writeTasks(home, SESSION_A, [task(1, 'Step', 'in_progress')])
  let clock = 1_000
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    trace: true,
    now: () => (clock += 10),
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: ['done'] },
      agents: [],
      offers: [{ kind: 'proposal', id: 'a', path: '/work/app', agent: 'claude', paneKey: 'p', suggestions: [] }]
    }),
    watchDir: () => {}
  })

  worker.agentChanged({ paneKey: 'tab:leaf', state: 'done', mainAgent: { state: 'done' } })
  // The same state again is heard but changes nothing.
  worker.agentChanged({ paneKey: 'tab:leaf', state: 'done', mainAgent: { state: 'done' } })
  await worker.refresh(true)

  const trace = lines.filter((line) => line.startsWith('milestone: trace '))
  assert.ok(trace.some((line) => line.includes('event agent.status.changed') && line.includes('pane=tab:leaf') && line.includes('state=done') && line.includes('changed=true')))
  assert.ok(trace.some((line) => line.includes('event agent.status.changed') && line.includes('changed=false')))
  const refreshed = trace.find((line) => line.includes('refresh'))
  assert.ok(refreshed, 'a refresh is traced')
  assert.match(refreshed, /asked=true/)
  assert.match(refreshed, /orca=\d+ms/)
  assert.match(refreshed, /sessions=\d+ms/)
  assert.match(refreshed, /offers=1/)
  assert.match(refreshed, /published=true/)
})
