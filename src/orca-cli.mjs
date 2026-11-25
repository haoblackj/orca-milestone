// Asks the Orca CLI which workspace is focused and what every agent is doing. The host
// API's workspace.readContext gives only a branch and a display name, which several repositories
// can share, and it says nothing about other workspaces, so both come from here.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { offersOf } from './next-actions.mjs'

/** The CLI bundled with the Orca app that runs this worker, else `orca` on PATH. */
export function resolveOrcaCli(execPath = process.execPath) {
  // The worker runs Orca's own binary as Node: Orca.app/Contents/MacOS/Orca.
  // On Windows: orca\Orca.exe, and the native launcher beside orca.cmd, which needs no shell.
  const bundled = [join(dirname(execPath), '..', 'Resources', 'bin', 'orca'), join(dirname(execPath), 'resources', 'bin', 'orca.exe')]
  return bundled.find((path) => existsSync(path)) ?? 'orca'
}

/**
 * The environment of the Orca CLI. Orca for Windows starts a worker without APPDATA, and the CLI
 * cannot find the running Orca without it (runtime_unavailable), so it gets the usual folders.
 */
export function cliEnv(env = process.env, platform = process.platform, home = homedir()) {
  if (platform !== 'win32') return env
  return { APPDATA: win32.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: win32.join(home, 'AppData', 'Local'), ...env }
}

export function runOrca(cli, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: cliEnv() }, (error, stdout, stderr) => {
      if (error) {
        // What the CLI said tells why it failed; the message alone names only the command.
        const said = `${stdout}\n${stderr}`.trim().slice(0, 500)
        reject(new Error(`${error.message.split('\n')[0]} (code ${error.code}, signal ${error.signal})${said ? `: ${said}` : ''}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

const TRACKED_AGENTS = new Set(['claude', 'codex'])

function mainAgents(worktree) {
  return (worktree.agents ?? []).filter((agent) => TRACKED_AGENTS.has(agent.agentType) && !agent.parentPaneKey)
}

/**
 * Whether a workspace may hold a Claude agent team: several Claude agents in one tab. The teammates
 * of Agent Teams run in panes beside their lead, and Orca lists each as an agent of its own.
 */
export function mayHoldTeam(worktrees) {
  return worktrees.some((worktree) => {
    const tabs = mainAgents(worktree).filter((agent) => agent.agentType === 'claude').map((agent) => agent.paneKey?.split(':')[0])
    return new Set(tabs).size < tabs.length
  })
}

/**
 * The workspaces with each teammate under its lead, as `parentPaneKey`, so that the lead alone
 * stands for the team: its cards, its state. Orca marks the terminal of a lead with the agent
 * identity `claude-agent-teams`; the other Claude agents in its tab are its teammates.
 * @param terminals the terminals of `orca terminal list`
 */
export function joinTeams(worktrees, terminals) {
  const leads = new Set(
    (terminals ?? []).filter((terminal) => terminal.agentIdentity === 'claude-agent-teams' && terminal.tabId && terminal.leafId).map((terminal) => `${terminal.tabId}:${terminal.leafId}`)
  )
  if (leads.size === 0) return worktrees
  return worktrees.map((worktree) => {
    const lead = mainAgents(worktree).find((agent) => leads.has(agent.paneKey))
    if (!lead) return worktree
    const tab = lead.paneKey.split(':')[0]
    const isTeammate = (agent) => agent !== lead && !agent.parentPaneKey && agent.agentType === 'claude' && agent.paneKey?.split(':')[0] === tab
    if (!worktree.agents.some(isTeammate)) return worktree
    return { ...worktree, agents: worktree.agents.map((agent) => (isTeammate(agent) ? { ...agent, parentPaneKey: lead.paneKey } : agent)) }
  })
}

/**
 * When the agent itself finished its turn, as Orca reports it apart from the shells it left running
 * (`mainAgent`, seen in Orca 1.4.257), or null when Orca does not say.
 */
function mainAgentDone(agent) {
  const main = agent.mainAgent
  return main?.state === 'done' && Number.isFinite(main.stateStartedAt) ? main.stateStartedAt : null
}

/**
 * Whether Orca itself says the agent is working (`mainAgent`, as above): then its turn is not over, and
 * the transcript has nothing to add. Reading it costs 0.13-0.25 s of every refresh over a WSL share, and
 * up to 2.6 s under load. Without `mainAgent`, or with one that does not say it, the transcript decides.
 */
function itselfWorking(agent) {
  return agent.mainAgent?.state === 'working'
}

/**
 * When the agent's turn ended (as `readTurnEnded` below resolves), or null: Orca's word first, the
 * transcript only when Orca does not say. When `mainAgent` stays `working` after the turn ended (Orca
 * missed the end), the transcript is not read and the agent stays working until Orca updates it.
 */
async function turnEnded(agent, path, readTurnEnded) {
  const done = mainAgentDone(agent)
  if (done !== null) return done
  if (itselfWorking(agent)) return null
  return readTurnEnded(path).catch(() => null)
}

/**
 * The workspaces with each Claude agent that Orca calls working but whose turn is over marked as
 * done, and `background`: shells it started go on running, and it waits for the user. Its proposals
 * then show as for any agent that finished. Its `stateStartedAt` becomes the end of the turn: Orca's
 * stays where the shells began, and the cards of every later turn would get the ids of the first.
 * @param readTurnEnded resolves a workspace path to when its Claude session ended its turn (true when
 *   the time is unknown), or null
 */
export async function settleAgents(worktrees, readTurnEnded) {
  const settled = []
  for (const worktree of worktrees) {
    const working = mainAgents(worktree).filter((agent) => agent.agentType === 'claude' && agent.state === 'working' && agent.hasLivePty === true)
    const ended = new Map()
    for (const agent of working) {
      // The transcript is found by the workspace, so it says nothing of one among several agents.
      const at = working.length === 1 ? await turnEnded(agent, worktree.path, readTurnEnded) : mainAgentDone(agent)
      if (at) ended.set(agent, at)
    }
    if (ended.size === 0) {
      settled.push(worktree)
      continue
    }
    const settle = (agent) => ({ ...agent, state: 'done', background: true, ...(typeof ended.get(agent) === 'number' ? { stateStartedAt: ended.get(agent) } : {}) })
    settled.push({ ...worktree, agents: worktree.agents.map((agent) => (ended.has(agent) ? settle(agent) : agent)) })
  }
  return settled
}

/**
 * The focused workspace ({ path, displayName, agentStates, background }, or null), the main agents of every
 * workspace that is not archived, and what each agent offers to choose from: its proposed next
 * steps, its question or the tool waiting for permission. Of the prompts and replies, only the
 * block an agent wrote for those buttons is kept.
 * @param readers how to read a pending question or call and a pane's screen, see offersOf,
 *   `readTurnEnded`, see settleAgents, and `readTerminals`, see joinTeams
 */
// An Orca bot lives in a folder of its own, which Orca lists as a workspace: ~/.orca/bots/<name>.
const BOT_HOME = /\/\.orca\/bots\/[^/]+\/?$/

export function isBotHome(path) {
  return typeof path === 'string' && BOT_HOME.test(path)
}

export async function readWorkspaces(cli, run = runOrca, readers = {}) {
  const response = await run(cli, ['worktree', 'ps', '--limit', '1000', '--json'])
  if (!response?.ok) {
    throw new Error(response?.error?.message ?? 'orca worktree ps failed')
  }
  const { readTurnEnded = async () => null, readTerminals = async () => (await run(cli, ['terminal', 'list', '--json']))?.result?.terminals ?? [], readFocusedId, ...offerReaders } = readers
  let listed = response.result.worktrees.filter((worktree) => !worktree.isArchived)
  // Asked about one environment, as for WSL, Orca marks no workspace active.
  if (readFocusedId && !listed.some((worktree) => worktree.isActive)) {
    const focused = await readFocusedId().catch(() => null)
    listed = listed.map((worktree) => (focused && worktree.worktreeId === focused ? { ...worktree, isActive: true } : worktree))
  }
  if (mayHoldTeam(listed)) listed = joinTeams(listed, await readTerminals().catch(() => []))
  const worktrees = await settleAgents(listed, readTurnEnded)
  const active = worktrees.find((worktree) => worktree.isActive)
  return {
    active: active
      ? {
          path: active.path,
          displayName: active.displayName,
          bot: isBotHome(active.path),
          agentStates: mainAgents(active).map((agent) => agent.state),
          background: mainAgents(active).some((agent) => agent.background === true)
        }
      : null,
    agents: worktrees.flatMap((worktree) =>
      mainAgents(worktree).map((agent) => ({
        workspace: worktree.displayName,
        repo: typeof worktree.repo === 'string' ? worktree.repo : null,
        path: worktree.path,
        bot: isBotHome(worktree.path),
        focused: Boolean(worktree.isActive),
        state: agent.state,
        background: agent.background === true,
        since: agent.stateStartedAt ?? null
      }))
    ),
    offers: await offersOf(worktrees, offerReaders)
  }
}
