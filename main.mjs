// Orca plugin worker entry for orca-milestone: shows the Claude tasks of the focused workspace
// as milestones in a right-sidebar panel.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLaunchHook } from './src/launch-hook.mjs'
import { createMilestoneWorker } from './src/milestone-worker.mjs'
import { configureHost } from './src/host.mjs'
import { resolveOrcaCli, runOrca } from './src/orca-cli.mjs'
import { findWslHost } from './src/wsl-host.mjs'

/** What `make` resolves to, made once; a failure is not kept, so the next call tries again. */
function kept(make) {
  let made = null
  return () => {
    made ??= make().catch((error) => {
      made = null
      throw error
    })
    return made
  }
}

export default function activate(orca, { platform = process.platform, findHost = findWslHost, createWorker = createMilestoneWorker } = {}) {
  const cli = resolveOrcaCli()
  // Agents of Orca for Windows may run in WSL, where a Windows path means nothing to them.
  if (platform === 'win32') configureHost({ permissionHook: false, codexProgress: false })
  // Looked up when first needed, not while the worker starts: Orca gives it 10 s for that, and after
  // four failed starts it gives up on the plugin until it is turned off and on. WSL can take longer to boot.
  const ready = kept(async () => {
    const wsl = await findHost(import.meta.dirname, { listEnvironments: () => runOrca(cli, ['environment', 'list', '--json'], 5_000) }).catch((error) => {
      orca.log(`milestone: could not find where the agents run: ${error.message}`)
      throw error
    })
    if (wsl) configureHost({ agentHome: wsl.agentHome, isRunning: wsl.isRunning, permissionHook: false, codexProgress: false })
    else if (platform === 'win32') configureHost({})
    return createWorker({
      orca,
      home: wsl?.home ?? homedir(),
      cli,
      ...(wsl && {
        watchDir: wsl.watchDir,
        statusPollMs: wsl.statusPollMs,
        readSettings: wsl.readSettings,
        trace: true,
        prefetchTerminals: true,
        runCli: (cli, args, timeout) => runOrca(cli, [...args, '--environment', wsl.environment], timeout),
        // The id of the focused workspace is the worktreeId `orca worktree ps` gives it.
        readFocusedId: async () => (await orca.host.call('workspace.readContext'))?.workspaceId ?? null
      })
    })
  })
  orca.hooks.on(
    'agent.launch.before',
    createLaunchHook({ execPath: process.execPath, serverPath: join(import.meta.dirname, 'src', 'progress-server.mjs') })
  )
  orca.panels.handle('view.get', async () => (await ready()).view())
  orca.panels.handle('workspace.open', async ({ path }) => (await ready()).openWorkspace(path))
  orca.panels.handle('next.send', async (request) => (await ready()).sendNext(request))
  orca.commands.register('milestone.refresh', async () => {
    const worker = await ready()
    await worker.start()
    await worker.refresh(true)
    return 'Milestones refreshed'
  })
  orca.events.on('agent.status.changed', async (event) => {
    const worker = await ready()
    await worker.start()
    worker.agentChanged(event)
  })
  orca.events.on('workspace.changed', async (event) => {
    const worker = await ready()
    await worker.start()
    worker.focusChanged(event?.context)
  })
}
