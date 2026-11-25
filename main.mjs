// Orca plugin worker entry for orca-milestone: shows the Claude tasks of the focused workspace
// as milestones in a right-sidebar panel.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLaunchHook } from './src/launch-hook.mjs'
import { createMilestoneWorker } from './src/milestone-worker.mjs'
import { configureHost } from './src/host.mjs'
import { resolveOrcaCli, runOrca } from './src/orca-cli.mjs'
import { findWslHost } from './src/wsl-host.mjs'

export default async function activate(orca) {
  const cli = resolveOrcaCli()
  // Orca for Windows, with the agents in a WSL distro. Orca gives a worker 10 s to start.
  const wsl = await findWslHost(import.meta.dirname, { listEnvironments: () => runOrca(cli, ['environment', 'list', '--json'], 5_000) })
  if (wsl) configureHost({ agentHome: wsl.agentHome, isRunning: wsl.isRunning, permissionHook: false, codexProgress: false })
  const worker = createMilestoneWorker({
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
  orca.hooks.on(
    'agent.launch.before',
    createLaunchHook({ execPath: process.execPath, serverPath: join(import.meta.dirname, 'src', 'progress-server.mjs') })
  )
  orca.panels.handle('view.get', () => worker.view())
  orca.panels.handle('workspace.open', ({ path }) => worker.openWorkspace(path))
  orca.panels.handle('next.send', (request) => worker.sendNext(request))
  orca.commands.register('milestone.refresh', async () => {
    await worker.start()
    await worker.refresh(true)
    return 'Milestones refreshed'
  })
  orca.events.on('agent.status.changed', async (event) => {
    await worker.start()
    worker.agentChanged(event)
  })
  orca.events.on('workspace.changed', async (event) => {
    await worker.start()
    worker.focusChanged(event?.context)
  })
}
