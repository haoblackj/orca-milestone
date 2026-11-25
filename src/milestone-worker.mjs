// Keeps the panel in step with the focused workspace, the task lists of Claude and Codex and the
// state of every agent Orca runs. The worker renders the body of the panel and posts it; the panel patches
// its DOM, so an update keeps the frame, the scroll position and a row's expansion.
import { watch } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  claudePaths,
  findListTranscript,
  currentGoal,
  isListRunning,
  readRunningSessionIds,
  readSessionStatuses,
  readTasksFromTranscript,
  listRecentTaskLists,
  readPromptBeforeTask,
  readTaskList,
  readTranscriptHead,
  createPendingReader,
  createChatReplyReader,
  pendingCall,
  turnEnded,
  pendingQuestion
} from './claude-sessions.mjs'
import { readCodexProgress } from './codex-progress.mjs'
import { buildModel, withPairedFocus } from './model.mjs'
import { createNextSender, readPaneScreen, readTerminalScreen } from './next-actions.mjs'
import { createLaunchInfoReader, createLaunchReader, createRestarter } from './restart.mjs'
import { createGrantAccess } from './turn-grant.mjs'
import { readWorkspaces, runOrca } from './orca-cli.mjs'
import { progressDir } from './progress-server.mjs'
import { createRemoteClient, statusUrl } from './remote.mjs'
import { renderBody } from './render.mjs'

const TASK_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// Events say when the focus or an agent changes. This catches what they do not, such as a session
// that ended without one.
const SYNC_MS = 30_000
const DEBOUNCE_MS = 150
const REQUEST_RETRY_MS = 30_000
// How often the sessions of another Mac are read, as often as the iPhone app reads them.
const REMOTE_MS = 10_000
const REMOTE_LABEL = 'リモート'

/** The terminal to show a workspace by: an agent's before a shell's, then the one that printed last. */
function terminalAt(terminals, path) {
  return terminals
    .filter((candidate) => candidate.worktreePath === path)
    .sort((a, b) => Number(Boolean(b.agentIdentity)) - Number(Boolean(a.agentIdentity)) || (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0))[0]
}

export function createMilestoneWorker({
  orca,
  home,
  cli,
  readOrca = readWorkspaces,
  runCli = runOrca,
  now = Date.now,
  // Which workspace is focused when Orca marks none active, see readWorkspaces.
  readFocusedId,
  watchDir = (dir, onChange) => watch(dir, { recursive: true }, onChange),
  // How often Claude's session files are read for a turn starting or ending, or null for never. Where
  // Orca sends no agent.status.changed (Orca for Windows, for agents in WSL) this is what notices the end of a turn.
  statusPollMs = null,
  // Lists the terminals after each refresh that asks Orca, for a pressed row to switch to one at once.
  // Where the host lists no workspace of the agents (Orca for Windows, for agents in WSL) a row
  // opens only through a terminal, and each CLI call takes 0.45-0.7 s.
  prefetchTerminals = false,
  // Writes the timing lines of trace() to the plugin log. They add a line per event and per refresh.
  trace: tracing = false,
  remote = createRemoteClient(),
  readSettings = async () => (await orca.host.call('settings.get')).settings ?? {},
  remoteMs = REMOTE_MS
}) {
  const paths = claudePaths(home)
  const { tasksRoot } = paths
  const progressRoot = progressDir(home)
  // Transcript heads never change once written; null entries are retried on the next refresh.
  const heads = new Map()
  // The request a list was made for, keyed by list and the subject of its first task.
  const requests = new Map()
  // Claude deletes a list's task files once every task is completed. The last tasks seen per
  // list keep a finished goal on screen as done instead of letting it vanish.
  const lastTasks = new Map()
  // Lists already replayed from a transcript, by list and the time it last changed.
  const replayed = new Map()
  let workspace = null
  // The focused workspace as Orca's `workspace.changed` gives it. A paired server's workspace is
  // only known this way.
  let context = null
  let agents = []
  let offers = []
  // The terminals of the latest listing, and the listing on its way, see prefetchTerminals.
  let knownTerminals = []
  let listing = null
  let listings = 0
  let keptListing = 0
  const runArgs = (args, timeout) => runCli(cli, args, timeout)
  // A question or a call waiting for permission is read from the transcript of Claude's session,
  // a Codex menu from the screen of its pane.
  const readLaunchInfo = createLaunchInfoReader(home)
  const grants = createGrantAccess(home)
  const readers = {
    readQuestion: createPendingReader(home, pendingQuestion),
    readCall: createPendingReader(home, pendingCall),
    // Orca calls an agent working while its background shells run, even after its turn.
    readTurnEnded: createPendingReader(home, turnEnded),
    readPane: (paneKey) => readPaneScreen(runArgs, paneKey),
    // A Claude session started with older instructions than the launch hook gives now.
    readLaunch: createLaunchReader(home, { readLaunchInfo }),
    readLaunchInfo,
    readAllowed: (sessionId) => grants.allowed(sessionId),
    readFocusedId,
    // Orca keeps only the start of what an agent in its chat said, without the next block.
    readReply: createChatReplyReader(home)
  }
  let lastHtml = null
  let started = null
  let timer = null
  let pendingFocus = false
  let running = null
  let rerun = false
  // The last state heard per pane. Agents repeat a state with every hook they fire.
  const paneStates = new Map()
  // The sessions of another Mac, `{ label, sessions }` or `{ label, error }`, and where they were
  // read; null while the settings name no daemon.
  let remoteView = null
  let remoteUrl = null
  let remoteRead = null
  let remoteTimer = null
  let settingsFailed = false

  async function headOf(listId) {
    if (heads.has(listId)) return heads.get(listId)
    const transcript = await findListTranscript(paths, listId)
    const head = transcript ? await readTranscriptHead(transcript).catch(() => null) : null
    if (head) heads.set(listId, { ...head, transcript })
    return heads.get(listId) ?? null
  }

  /**
   * What a list is for right now. A session moves on to new goals, so its first prompt is only
   * a last resort: the goal Claude wrote on the tasks comes first, then the request the first
   * task was created for.
   */
  async function goalOf(listId, head, tasks) {
    const current = currentGoal(tasks)
    if (current.goal) return current
    const key = `${listId}\n${tasks[0].subject}`
    let request = requests.get(key)
    // A miss is retried later: the transcript can trail the task files, and a teammate's tasks
    // are not in the lead's transcript at all, so a whole read is not repeated every refresh.
    if (!request || (request.prompt === null && now() - request.at > REQUEST_RETRY_MS)) {
      const prompt = await readPromptBeforeTask(head.transcript, tasks[0].subject).catch(() => null)
      request = { prompt, at: now() }
      requests.set(key, request)
    }
    return { goal: request.prompt ?? head.goal, tasks }
  }

  function isFinished(tasks) {
    return tasks.length > 0 && tasks.every((task) => task.status === 'completed')
  }

  /**
   * A finished list whose files Claude already deleted, replayed from its transcript. That
   * happens when the worker starts after the list was finished, as after a restart.
   */
  async function replayFinished(list) {
    const key = `${list.listId}\n${list.updatedAt}`
    if (replayed.has(key)) return
    replayed.set(key, true)
    // Only a list that ever had tasks keeps a high-water mark.
    if (!(await stat(join(list.dir, '.highwatermark')).catch(() => null))) return
    const head = await headOf(list.listId)
    if (!head?.transcript) return
    const tasks = await readTasksFromTranscript(head.transcript).catch(() => [])
    if (isFinished(tasks)) lastTasks.set(list.listId, tasks)
  }

  async function allSessions() {
    const running = await readRunningSessionIds(paths.sessionsRoot)
    const lists = await listRecentTaskLists(tasksRoot, { maxAgeMs: TASK_LIST_MAX_AGE_MS })
    const sessions = []
    for (const list of lists) {
      // A list shows only while its session runs: ending the session or removing its
      // workspace takes it off the panel.
      if (!isListRunning(list.listId, running)) {
        lastTasks.delete(list.listId)
        continue
      }
      const files = await readTaskList(list.dir)
      if (files.length === 0 && !lastTasks.has(list.listId)) await replayFinished(list)
      const tasks = currentTasks(list.listId, files)
      // A team creates its list when it starts, and most stay empty; they are not looked up.
      if (tasks.length === 0) continue
      const head = await headOf(list.listId)
      if (!head?.cwd) continue
      sessions.push({ ...list, cwd: head.cwd, ...(await goalOf(list.listId, head, tasks)) })
    }
    sessions.push(...(await readCodexProgress(progressRoot)))
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function currentTasks(listId, tasks) {
    if (tasks.length > 0) {
      lastTasks.set(listId, tasks)
      return tasks
    }
    const previous = lastTasks.get(listId) ?? []
    // A list emptied before it was finished was cleared on purpose; show nothing for it.
    return isFinished(previous) ? previous : []
  }

  /** Whether the body differed and was posted. */
  function publish(html) {
    if (html === lastHtml) return false
    lastHtml = html
    orca.panels.post('view.changed', { html })
    return true
  }

  /** What a panel shows when it opens; it starts the worker's refreshes if nothing has yet. */
  async function view() {
    await start()
    return { html: lastHtml ?? renderBody({ kind: 'no-workspace' }) }
  }

  async function listTerminals() {
    const started = ++listings
    const { terminals = [] } = (await runArgs(['terminal', 'list', '--json']))?.result ?? {}
    // A background listing can end after one a press started later: the later one is newer.
    if (started > keptListing) {
      keptListing = started
      knownTerminals = terminals
    }
    return terminals
  }

  /** Lists the terminals in the background; one listing at a time. */
  function prefetch() {
    if (!prefetchTerminals || listing) return
    listing = listTerminals()
      .catch((error) => orca.log(`milestone: could not list the terminals: ${error.message}`))
      .finally(() => {
        listing = null
      })
  }

  async function switchTo(terminal) {
    const reply = await runArgs(['terminal', 'switch', '--terminal', terminal.handle, '--json'])
    if (reply?.ok === false) throw new Error(reply.error?.message ?? 'orca terminal switch failed')
    return reply
  }

  /** Shows the workspace at a path. A pressed row may be stale by now, so a miss is only logged. */
  async function openWorkspace(path) {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      const target = workspaces.find((candidate) => candidate.path === path)
      if (target) {
        await orca.host.call('workspace.open', { workspaceId: target.id })
        return { opened: true }
      }
      // The host lists only the workspaces of the machine the worker runs on: none of a WSL distro
      // under Orca for Windows. The CLI, asked about that environment, switches the desktop to a
      // terminal of it, which shows its workspace. An agent's terminal shows the session itself.
      const known = terminalAt(knownTerminals, path)
      if (known) {
        const reply = await switchTo(known).catch((error) => {
          orca.log(`milestone: could not switch to a listed terminal, listing again: ${error.message}`)
          return null
        })
        // A terminal closed since it was listed: list them again.
        if (reply) return { opened: reply.result?.focus?.navigated !== false }
      }
      const terminal = terminalAt(await listTerminals(), path)
      if (!terminal) {
        orca.log(`milestone: no workspace to open at ${path}`)
        return { opened: false }
      }
      const reply = await switchTo(terminal)
      return { opened: reply?.result?.focus?.navigated !== false }
    } catch (error) {
      orca.log(`milestone: could not open the workspace: ${error.message}`)
      return { opened: false }
    }
  }

  // Wall-clock lines in the plugin log (`orca plugin logs`), to set against Claude's transcript times:
  // what a card waits for is not visible from outside the worker.
  function trace(line) {
    if (!tracing) return
    try {
      orca.log(`milestone: trace t=${now()} ${line}`)
    } catch {
      // A log that fails must not stop what it only describes.
    }
  }

  async function refreshOnce(askOrca) {
    const started = now()
    let orcaMs = 0
    if (askOrca || !workspace) {
      try {
        let found
        ;({ active: workspace, agents, offers: found } = await readOrca(cli, runCli, readers))
        offers = found ?? []
      } catch (error) {
        orca.log(`milestone: could not read the workspaces: ${error.message}`)
      }
      orcaMs = now() - started
      prefetch()
    }
    const sessionsStarted = now()
    const sessions = await allSessions()
    const sessionsMs = now() - sessionsStarted
    const changed = publish(renderBody(withPairedFocus(buildModel(workspace, sessions, agents, offers), context, remoteView)))
    trace(`refresh asked=${Boolean(askOrca)} orca=${orcaMs}ms sessions=${sessionsMs}ms offers=${offers.length} published=${changed}`)
  }

  /** Reads the daemon the settings name, one read at a time, and redraws with what it has. */
  function readRemote() {
    remoteRead ??= (async () => {
      try {
        let settings = {}
        try {
          settings = await readSettings()
          settingsFailed = false
        } catch (error) {
          if (!settingsFailed) orca.log(`milestone: could not read the settings: ${error.message}`)
          settingsFailed = true
        }
        const url = statusUrl(settings.remoteUrl)
        const label = typeof settings.remoteLabel === 'string' && settings.remoteLabel.trim() ? settings.remoteLabel.trim() : REMOTE_LABEL
        const previous = remoteView
        remoteUrl = url
        // Its own quicker timer only while a daemon is named.
        if (url && !remoteTimer) remoteTimer = setInterval(() => void readRemote(), remoteMs)
        if (!url && remoteTimer) {
          clearInterval(remoteTimer)
          remoteTimer = null
        }
        remoteView = url ? { label, ...(await remote.read(url)) } : null
        if (JSON.stringify(previous) !== JSON.stringify(remoteView)) schedule(false, 'remote-changed')
      } finally {
        remoteRead = null
      }
    })()
    return remoteRead
  }

  /** Whether a pressed card is one of the other Mac's, which only its daemon can send. */
  function isRemoteOffer(offerId) {
    return Boolean(remoteUrl && remoteView?.sessions?.some((session) => session.offer?.id === offerId))
  }

  /** Runs refreshes one at a time; a request during a run starts one more afterwards. */
  async function refresh(focusChanged = false) {
    pendingFocus ||= focusChanged
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        const focus = pendingFocus
        pendingFocus = false
        try {
          await refreshOnce(focus)
        } catch (error) {
          orca.log(`milestone: refresh failed: ${error.message}`)
        }
      } while (rerun)
    })()
    try {
      await running
    } finally {
      running = null
    }
  }

  const sendOffer = createNextSender({
    readOffers: async () => (await readOrca(cli, runCli, readers)).offers ?? [],
    run: runArgs,
    grantRest: (sessionId) => grants.grant(sessionId),
    restart: createRestarter({ home, run: runArgs, readLaunch: readers.readLaunch, readScreen: (handle) => readTerminalScreen(runArgs, handle) })
  })

  /** Sends the prompt of a pressed button to its agent; the panel shows what went wrong. */
  async function sendNext(request) {
    if (isRemoteOffer(request?.offer)) {
      const result = await remote.press(remoteUrl, request)
      if (result.sent) void readRemote()
      return result
    }
    try {
      const result = await sendOffer(request)
      if (result.sent) schedule(true, 'next-sent')
      return result
    } catch (error) {
      orca.log(`milestone: could not send the next step: ${error.message}`)
      return { sent: false, reason: 'failed' }
    }
  }

  function schedule(focusChanged = false, source = 'unknown') {
    trace(`schedule source=${source} askOrca=${focusChanged}`)
    pendingFocus ||= focusChanged
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), DEBOUNCE_MS)
  }

  /** Orca focused another workspace, here or on a paired server. */
  function focusChanged(focused) {
    context = focused ?? null
    schedule(true, 'workspace.changed')
  }

  function agentChanged({ paneKey, state, mainAgent }) {
    const key = `${state}\n${mainAgent?.state ?? ''}`
    const changed = paneStates.get(paneKey) !== key
    trace(`event agent.status.changed pane=${paneKey} state=${state} main=${mainAgent?.state ?? ''} changed=${changed}`)
    if (!changed) return
    paneStates.set(paneKey, key)
    schedule(true, 'agent.status.changed')
  }

  /** Asks Orca again whenever a session's busy or idle state moves; the first read only sets the baseline. */
  function pollSessionStatus() {
    let last = null
    const poll = async () => {
      try {
        const began = now()
        // A failed read keeps `last`: it is no sign that the sessions are gone.
        const statuses = await readSessionStatuses(paths.sessionsRoot).catch(() => null)
        if (statuses) {
          const moved = last !== null && [...statuses].some(([file, status]) => last.get(file) !== status)
          last = statuses
          if (moved) schedule(true, `session-status poll=${now() - began}ms`)
        }
      } catch (error) {
        orca.log(`milestone: could not watch the sessions: ${error.message}`)
      } finally {
        setTimeout(poll, statusPollMs).unref?.()
      }
    }
    void poll()
  }

  function start() {
    started ??= (async () => {
      await mkdir(tasksRoot, { recursive: true })
      await mkdir(progressRoot, { recursive: true })
      if (statusPollMs) pollSessionStatus()
      watchDir(tasksRoot, (_event, name) => {
        if (name && !String(name).endsWith('.lock')) schedule(false, 'tasks-changed')
      })
      watchDir(progressRoot, () => schedule(false, 'progress-changed'))
      // The slow sync also notices a daemon named or cleared in the settings.
      setInterval(() => {
        schedule(true, 'sync-interval')
        void readRemote()
      }, SYNC_MS)
      // Not awaited: a daemon out of reach must not hold up the first view.
      void readRemote()
      await refresh(true)
    })()
    return started
  }

  return { start, refresh, schedule, focusChanged, agentChanged, view, openWorkspace, sendNext, readRemote }
}
