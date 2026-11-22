import assert from 'node:assert/strict'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  claudePaths,
  findListTranscript,
  findTranscript,
  currentGoal,
  listRecentTaskLists,
  isListRunning,
  readPromptBeforeTask,
  readRunningSessionIds,
  readSessionStatuses,
  readTasksFromTranscript,
  readTaskList,
  readTranscriptHead
} from '../src/claude-sessions.mjs'
import { SESSION_A, SESSION_B, makeHome, markRunning, task, taskCalls, writeTasks, writeTranscript } from './helpers.mjs'

test('readTaskList orders tasks by numeric id and skips other files', async () => {
  const home = await makeHome()
  const dir = await writeTasks(home, SESSION_A, [
    task(10, 'Ten', 'pending'),
    task(2, 'Two', 'completed'),
    task(1, 'One', 'in_progress')
  ])
  assert.deepEqual(
    (await readTaskList(dir)).map((t) => t.subject),
    ['One', 'Two', 'Ten']
  )
  assert.deepEqual(await readTaskList(join(home, 'missing')), [])
})

test('listRecentTaskLists keeps session and team lists changed within the window, newest first', async () => {
  const home = await makeHome()
  const { tasksRoot } = claudePaths(home)
  const now = Date.now()
  await utimes(await writeTasks(home, SESSION_A, [task(1, 'A', 'pending')]), now / 1000, (now - 5000) / 1000)
  await utimes(await writeTasks(home, SESSION_B, [task(1, 'B', 'pending')]), now / 1000, (now - 1000) / 1000)
  await utimes(await writeTasks(home, 'session-1234abcd', []), now / 1000, (now - 3000) / 1000)
  await mkdir(join(tasksRoot, 'not-a-list'), { recursive: true })
  const lists = await listRecentTaskLists(tasksRoot, { now, maxAgeMs: 60_000 })
  assert.deepEqual(lists.map((list) => list.listId), [SESSION_B, 'session-1234abcd', SESSION_A])
  assert.deepEqual(await listRecentTaskLists(tasksRoot, { now, maxAgeMs: 2000 }).then((l) => l.map((x) => x.listId)), [SESSION_B])
})

test('findListTranscript finds a team lead by the team config, or by the id prefix once it is gone', async () => {
  const home = await makeHome()
  const paths = claudePaths(home)
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Lead the team' })
  const teamDir = join(paths.teamsRoot, 'session-11111111')
  await mkdir(teamDir, { recursive: true })
  await writeFile(join(teamDir, 'config.json'), JSON.stringify({ leadSessionId: SESSION_A }))
  const expected = await findTranscript(paths.projectsRoot, SESSION_A)
  assert.equal(await findListTranscript(paths, 'session-11111111'), expected)
  assert.equal(await findListTranscript(paths, SESSION_A), expected)
  assert.equal(await findListTranscript({ ...paths, teamsRoot: join(home, 'no-teams') }, 'session-11111111'), expected)
  assert.equal(await findListTranscript(paths, 'session-22222222'), null)
})

test('readTranscriptHead finds the cwd, branch and first real prompt', async () => {
  const home = await makeHome()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', gitBranch: 'feat/x', prompt: '  Ship the milestone panel  ' })
  const path = await findTranscript(claudePaths(home).projectsRoot, SESSION_A)
  assert.ok(path)
  assert.deepEqual(await readTranscriptHead(path), {
    cwd: '/work/app',
    gitBranch: 'feat/x',
    goal: 'Ship the milestone panel'
  })
  assert.equal(await findTranscript(claudePaths(home).projectsRoot, SESSION_B), null)
})

test('currentGoal keeps the tasks of the newest goal Claude wrote', () => {
  const plain = [task(1, 'a', 'completed'), task(2, 'b', 'pending')]
  assert.deepEqual(currentGoal(plain), { goal: null, tasks: plain })
  const goal = (text) => ({ metadata: { goal: text } })
  const { goal: current, tasks } = currentGoal([
    task(1, 'old 1', 'completed', goal('Old goal')),
    task(2, 'loose old', 'completed'),
    task(3, 'old 2', 'completed', goal('Old goal')),
    task(4, 'new 1', 'completed', goal('  New goal ')),
    task(5, 'loose new', 'pending'),
    task(6, 'new 2', 'pending', goal('New goal'))
  ])
  assert.equal(current, 'New goal')
  assert.deepEqual(tasks.map((t) => t.subject), ['new 1', 'loose new', 'new 2'])
})

test('readPromptBeforeTask finds the request a task was created for, across chunk edges', async () => {
  const home = await makeHome()
  const path = join(home, 'session.jsonl')
  const user = (content, extra = {}) => ({ type: 'user', ...extra, message: { role: 'user', content } })
  const create = (subject) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', input: { subject } }] }
  })
  // Long lines put the chunk edges inside entries and inside multi-byte characters.
  const filler = (n) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'あ'.repeat(n) }] } })
  const lines = [
    user('最初のゴール'),
    create('Old step'),
    filler(400_000),
    user('次のゴールに切り替えて'),
    user('<system-reminder>x</system-reminder>'),
    user([{ type: 'tool_result', content: 'ok' }]),
    filler(500_000),
    create('New step'),
    user('[Request interrupted by user]'),
    filler(300_000)
  ]
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  assert.equal(await readPromptBeforeTask(path, 'New step'), '次のゴールに切り替えて')
  assert.equal(await readPromptBeforeTask(path, 'Old step'), '最初のゴール')
  assert.equal(await readPromptBeforeTask(path, 'Missing step'), null)
})

test('readRunningSessionIds keeps sessions whose process runs; isListRunning matches team lists by prefix', async () => {
  const home = await makeHome()
  const { sessionsRoot } = claudePaths(home)
  await markRunning(home, SESSION_A)
  await writeFile(join(sessionsRoot, '999999.json'), JSON.stringify({ pid: 2 ** 22 + 7, sessionId: SESSION_B }))
  await writeFile(join(sessionsRoot, '1.other.key'), 'not a session')
  const running = await readRunningSessionIds(sessionsRoot)
  assert.deepEqual([...running], [SESSION_A])
  assert.ok(isListRunning(SESSION_A, running))
  assert.ok(isListRunning('session-11111111', running))
  assert.ok(!isListRunning(SESSION_B, running))
  assert.ok(!isListRunning('session-22222222', running))
})

test('readTasksFromTranscript replays the list, starting over once a finished list gets new tasks', async () => {
  const home = await makeHome()
  const calls = taskCalls(
    [{ subject: 'A1' }, { subject: 'A2' }],
    [{ taskId: '1', status: 'completed' }, { taskId: '2', status: 'completed' }]
  )
  // Ids keep counting across lists: B1..B3 are tasks 3..5.
  const next = taskCalls(
    [{ subject: 'B1', activeForm: 'Doing B1', metadata: { goal: 'B' } }, { subject: 'B2' }, { subject: 'B3' }],
    [{ taskId: '3', status: 'in_progress' }, { taskId: '5', status: 'deleted' }, { taskId: '4', subject: 'B2 renamed' }],
    3
  )
  const path = await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Go', extra: [...calls, ...next] })
  const tasks = await readTasksFromTranscript(path)
  assert.deepEqual(
    tasks.map((t) => [t.id, t.subject, t.status]),
    [['3', 'B1', 'in_progress'], ['4', 'B2 renamed', 'pending']]
  )
  assert.deepEqual([tasks[0].activeForm, tasks[0].metadata], ['Doing B1', { goal: 'B' }])
})

test('readSessionStatuses gives each session file its busy or idle state and when it changed, and skips what is no session file', async () => {
  const home = await makeHome()
  const { sessionsRoot } = claudePaths(home)
  await mkdir(sessionsRoot, { recursive: true })
  await writeFile(join(sessionsRoot, '101.json'), JSON.stringify({ pid: 101, sessionId: SESSION_A, status: 'busy', statusUpdatedAt: 5 }))
  await writeFile(join(sessionsRoot, '102.json'), JSON.stringify({ pid: 102, sessionId: SESSION_B, status: 'idle', statusUpdatedAt: 9 }))
  await writeFile(join(sessionsRoot, '104.json'), 'not json')
  await writeFile(join(sessionsRoot, '101.abc.key'), '{}')
  const statuses = await readSessionStatuses(sessionsRoot)
  assert.deepEqual([...statuses].sort(), [['101.json', 'busy@5'], ['102.json', 'idle@9']])
})

test('readSessionStatuses keeps a session whose id sits in several files, since a resumed session leaves its old files behind', async () => {
  const home = await makeHome()
  const { sessionsRoot } = claudePaths(home)
  await mkdir(sessionsRoot, { recursive: true })
  // The live file sorts first and the stale one last: neither may hide the other.
  await writeFile(join(sessionsRoot, '200.json'), JSON.stringify({ pid: 200, sessionId: SESSION_A, status: 'busy', statusUpdatedAt: 1 }))
  await writeFile(join(sessionsRoot, '900.json'), JSON.stringify({ pid: 900, sessionId: SESSION_A, status: 'idle', statusUpdatedAt: 0 }))
  const before = await readSessionStatuses(sessionsRoot)
  await writeFile(join(sessionsRoot, '200.json'), JSON.stringify({ pid: 200, sessionId: SESSION_A, status: 'idle', statusUpdatedAt: 2 }))
  const after = await readSessionStatuses(sessionsRoot)
  assert.equal(before.get('200.json'), 'busy@1')
  assert.equal(after.get('200.json'), 'idle@2')
  assert.equal(after.get('900.json'), 'idle@0')
})

test('readSessionStatuses reads again only a file whose time moved, and keeps what it knew of a file it fails to read', async () => {
  const home = await makeHome()
  const { sessionsRoot } = claudePaths(home)
  await mkdir(sessionsRoot, { recursive: true })
  const file = join(sessionsRoot, '101.json')
  const when = new Date('2026-01-01T00:00:00Z')
  await writeFile(file, JSON.stringify({ pid: 101, sessionId: SESSION_A, status: 'busy', statusUpdatedAt: 1 }))
  await utimes(file, when, when)
  const known = new Map()
  assert.equal((await readSessionStatuses(sessionsRoot, known)).get('101.json'), 'busy@1')

  // Same time: what is cached is used, so the file is not read.
  await writeFile(file, JSON.stringify({ pid: 101, sessionId: SESSION_A, status: 'idle', statusUpdatedAt: 2 }))
  await utimes(file, when, when)
  assert.equal((await readSessionStatuses(sessionsRoot, known)).get('101.json'), 'busy@1')

  // A new time with a torn write: the known state stays rather than the session vanishing.
  await writeFile(file, '{"pid":')
  assert.equal((await readSessionStatuses(sessionsRoot, known)).get('101.json'), 'busy@1')

  const later = new Date('2026-01-01T00:00:10Z')
  await writeFile(file, JSON.stringify({ pid: 101, sessionId: SESSION_A, status: 'idle', statusUpdatedAt: 3 }))
  await utimes(file, later, later)
  assert.equal((await readSessionStatuses(sessionsRoot, known)).get('101.json'), 'idle@3')
})

test('readSessionStatuses rejects when the folder cannot be listed, so a failed read is not taken for no sessions', async () => {
  const home = await makeHome()
  await assert.rejects(readSessionStatuses(join(home, 'missing')))
})
