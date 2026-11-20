// Orca plugin worker entry for orca-milestone: shows the Claude tasks of the focused workspace
// as milestones in a right-sidebar panel.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLaunchHook } from './src/launch-hook.mjs'
import { createMilestoneWorker } from './src/milestone-worker.mjs'
import { configureHost } from './src/host.mjs'
import { resolveOrcaCli, runOrca } from './src/orca-cli.mjs'
import { focusedPathOf, wslHostOf } from './src/wsl-host.mjs'

export default function activate(orca) {
  // Orca for Windows, with the agents in the WSL distro this folder lives in.
  const wsl = wslHostOf(import.meta.dirname)
  if (wsl) configureHost({ isRunning: wsl.isRunning, permissionHook: false, codexProgress: false })
  const worker = createMilestoneWorker({
    orca,
    home: wsl?.home ?? homedir(),
    cli: resolveOrcaCli(),
    ...(wsl && {
      runCli: (cli, args, timeout) => runOrca(cli, [...args, '--environment', wsl.environment], timeout),
      readFocusedPath: async () =>
        focusedPathOf(await orca.host.call('workspace.readContext'), (await orca.host.call('workspace.list')).workspaces)
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
  orca.events.on('workspace.changed', async () => {
    await worker.start()
    worker.schedule(true)
  })
}
