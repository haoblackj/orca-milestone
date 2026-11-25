import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNextSender, nextOffer, offersOf, parseSuggestions } from '../src/next-actions.mjs'
import { buildModel } from '../src/model.mjs'
import { renderBody } from '../src/render.mjs'

const block = (list) => `done\n\n\`\`\`next\n${JSON.stringify(list)}\n\`\`\`\n`
const proposal = (extra = {}) => ({ label: 'PR を作る', prompt: 'PR を作ってください', ...extra })
const agent = (extra = {}) => ({
  agentType: 'claude',
  state: 'done',
  paneKey: 'tab:leaf',
  hasLivePty: true,
  stateStartedAt: 5,
  lastAssistantMessage: block([proposal({ reason: '確認が済んだため' })]),
  ...extra
})
const worktree = (agents, extra = {}) => ({ path: '/work/app', agents, ...extra })

test('parseSuggestions keeps up to three valid buttons from a block at the very end', () => {
  assert.deepEqual(parseSuggestions(block([proposal({ reason: ' 確認が済んだため ' })])), [{ ...proposal(), reason: '確認が済んだため' }])
  assert.equal(parseSuggestions(block([1, 2, 3, 4].map((n) => proposal({ label: `L${n}` })))).length, 3)
  for (const bad of [proposal({ prompt: '-rf' }), proposal({ prompt: 'あ'.repeat(301) }), proposal({ label: 'a\nb' }), proposal({ prompt: 'a\nb' }), { label: 'x' }]) {
    assert.deepEqual(parseSuggestions(block([bad])), [], JSON.stringify(bad))
  }
  assert.deepEqual(parseSuggestions(`${block([proposal()])}and more`), [])
  assert.deepEqual(parseSuggestions('```next\nnot json\n```'), [])
  assert.deepEqual(parseSuggestions(null), [])
})

// The panel's cards wrap a label onto more lines rather than cut it, so a label over the limit is a
// matter of looks. It costs the end of the label, not the card (as a bad reason costs only the reason).
test('a label over the limit is shortened to the limit with an ellipsis, and its card is kept', () => {
  const long = parseSuggestions(block([proposal({ label: 'あ'.repeat(31), reason: '理由' })]))
  assert.equal(long.length, 1)
  assert.equal(long[0].label, `${'あ'.repeat(29)}…`)
  assert.equal([...long[0].label].length, 30)
  assert.equal(long[0].prompt, 'PR を作ってください')
  assert.equal(long[0].reason, '理由')

  // Exactly at the limit, and below it, nothing changes: not even the spaces inside the label.
  assert.equal(parseSuggestions(block([proposal({ label: 'あ'.repeat(30) })]))[0].label, 'あ'.repeat(30))
  assert.equal(parseSuggestions(block([proposal({ label: 'PR  を  作る' })]))[0].label, 'PR  を  作る')
  // Far over the limit, with the spaces around trimmed first.
  assert.equal(parseSuggestions(block([proposal({ label: `  ${'readTurnEnded を status で置き換えられるか調べる'}  ` })]))[0].label, 'readTurnEnded を status で置き換えら…')
  assert.equal(parseSuggestions(block([proposal({ label: 'あ'.repeat(200) })]))[0].label, `${'あ'.repeat(29)}…`)
})

test('a label is cut between characters, never inside a surrogate pair, and one already ending in an ellipsis is cut like any other', () => {
  // '😀' is two UTF-16 units: a cut by units at 29 would leave half of it.
  const emoji = parseSuggestions(block([proposal({ label: `${'あ'.repeat(28)}😀😀😀` })]))[0].label
  assert.equal(emoji, `${'あ'.repeat(28)}😀…`)
  assert.equal([...emoji].length, 30)
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji), 'no lone surrogate')
  assert.equal(parseSuggestions(block([proposal({ label: `${'x'.repeat(40)}…` })]))[0].label, `${'x'.repeat(29)}…`)
})

test('a workspace whose agent wrote a label over the limit still gets its card', () => {
  const offer = nextOffer(worktree([agent({ lastAssistantMessage: block([proposal({ label: 'mainAgent が working なら transcript を読まない' })]) })]))
  assert.equal(offer.suggestions.length, 1)
  assert.equal([...offer.suggestions[0].label].length, 30)
  assert.ok(offer.suggestions[0].label.endsWith('…'))
})

test('a bad reason costs only the reason', () => {
  for (const reason of [undefined, 3, '', 'a\nb']) assert.equal(parseSuggestions(block([proposal({ reason })]))[0].reason, '', String(reason))
})

test('nextOffer comes from the one live main agent that finished its turn', () => {
  const offer = nextOffer(worktree([agent()]))
  assert.equal(offer.path, '/work/app')
  assert.equal(offer.agent, 'claude')
  assert.equal(offer.paneKey, 'tab:leaf')
  assert.equal(offer.suggestions.length, 1)
  assert.notEqual(offer.id, nextOffer(worktree([agent({ stateStartedAt: 6 })])).id, 'another turn, another offer')
  const none = (wt) => assert.equal(nextOffer(wt), null)
  none(worktree([agent({ state: 'working' })]))
  none(worktree([agent({ lastAssistantMessage: 'no block' })]))
  none(worktree([agent({ agentType: 'gemini' })]))
  none(worktree([agent()], { isArchived: true }))
  // A closed pane's record and a teammate do not count as a second agent.
  assert.ok(nextOffer(worktree([agent(), agent({ paneKey: 'old', hasLivePty: undefined }), agent({ paneKey: 'mate', parentPaneKey: 'tab:leaf' })])))
})

// A card is sent to the pane of the agent that proposed it, so several agents in one workspace do not
// mix their cards up; the cards name their agent, for the user to tell them apart.
test('in a workspace of several agents, each one that finished its turn offers its cards, named, the last to finish first', async () => {
  const notes = agent({ paneKey: 'tab:notes', conversationName: 'リリースノートを書く', stateStartedAt: 9 })
  const older = agent({ paneKey: 'tab:older', conversationName: '前の作業', stateStartedAt: 3 })
  const busy = agent({ paneKey: 'tab:busy', conversationName: '整理', state: 'working', lastAssistantMessage: '' })
  const quiet = agent({ paneKey: 'tab:quiet', stateStartedAt: 12, lastAssistantMessage: 'no block' })
  const offers = await offersOf([worktree([busy, older, quiet, notes])])
  assert.deepEqual(offers.map((offer) => [offer.paneKey, offer.from]), [['tab:notes', 'リリースノートを書く'], ['tab:older', '前の作業']])
  assert.notEqual(offers[0].id, offers[1].id)

  assert.deepEqual(await offersOf([worktree([busy, quiet])]), [])
  assert.equal((await offersOf([worktree([agent()])]))[0].from, undefined, 'one agent needs no name')
  const [{ from }] = await offersOf([worktree([busy, agent({ paneKey: 'tab:long', conversationName: 'あ'.repeat(100) })])])
  assert.equal([...from].length, 60, 'a long name is shortened')
})

test('the focused workspace shows the cards of every agent that offers some, under one heading', async () => {
  const offers = await offersOf([
    worktree([agent({ paneKey: 'tab:a', conversationName: '前の作業', stateStartedAt: 3 }), agent({ paneKey: 'tab:b', conversationName: 'リリースノートを書く', stateStartedAt: 9 })]),
    worktree([agent({ paneKey: 'tab:c' })], { path: '/work/other' })
  ])
  const html = renderBody(buildModel({ path: '/work/app', displayName: 'app', agentStates: ['done', 'done'] }, [], [], offers))
  assert.equal(html.split('class="next proposal"').length - 1, 2)
  assert.equal(html.split('次の作業').length - 1, 1)
  assert.ok(html.indexOf('リリースノートを書く から') < html.indexOf('前の作業 から'))
  for (const { id, path } of offers) assert.equal(html.includes(`data-next="${id}"`), path === '/work/app')
})

test('a card of an agent that did not finish last is sent to that agent', async () => {
  const offers = await offersOf([worktree([agent({ paneKey: 'tab:a', stateStartedAt: 3 }), agent({ paneKey: 'tab:b', stateStartedAt: 9 })])])
  const sentTo = []
  const send = createNextSender({
    readOffers: async () => offers,
    wait: async () => {},
    run: async (args) => {
      if (args[1] === 'list') return { result: { terminals: ['a', 'b'].map((leaf) => ({ handle: `term-${leaf}`, tabId: 'tab', leafId: leaf, writable: true })) } }
      if (args[1] === 'send') sentTo.push(args[args.indexOf('--terminal') + 1])
      return { result: { send: { accepted: true } } }
    }
  })
  assert.deepEqual(await send({ offer: offers.find((offer) => offer.paneKey === 'tab:a').id, index: 0 }), { sent: true })
  assert.ok(sentTo.length > 0 && sentTo.every((handle) => handle === 'term-a'), sentTo.join())
  assert.deepEqual(await send({ offer: offers.find((offer) => offer.paneKey === 'tab:b').id, index: 0 }), { sent: true }, 'the other one stays usable')
})

function setupSender({ agentType = 'claude', screen = '? for shortcuts', accepted = true, terminals } = {}) {
  const offer = nextOffer(worktree([agent({ agentType })]))
  const calls = []
  const send = createNextSender({
    readOffers: async () => [offer],
    run: async (args) => {
      calls.push(args)
      if (args[1] === 'list') return { result: { terminals: terminals ?? [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: true }] } }
      if (args[1] === 'read') return { result: { terminal: { tail: [screen] } } }
      return { result: { send: { accepted } } }
    },
    wait: async () => {}
  })
  const sent = () => calls.filter((args) => args[1] === 'send').map((args) => args[args.indexOf('--text') + 1])
  return { offer, send, sent }
}

test('a press sends the prompt read again from the reply, after stashing a Claude draft', async () => {
  const context = setupSender()
  assert.deepEqual(await context.send({ offer: context.offer.id, index: 0 }), { sent: true })
  assert.deepEqual(context.sent(), ['\u0013', 'PR を作ってください'])
})

test('a second press, an old button and a missing terminal send nothing', async () => {
  const context = setupSender()
  await context.send({ offer: context.offer.id, index: 0 })
  assert.deepEqual(await context.send({ offer: context.offer.id, index: 0 }), { sent: false, reason: 'stale' })
  assert.deepEqual(await context.send({ offer: 'old', index: 0 }), { sent: false, reason: 'stale' })
  assert.deepEqual(await context.send({ offer: context.offer.id, index: 5 }), { sent: false, reason: 'stale' })
  assert.deepEqual(await context.send({ offer: 3, index: '0' }), { sent: false, reason: 'stale' })
  const closed = setupSender({ terminals: [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: false }] })
  assert.deepEqual(await closed.send({ offer: closed.offer.id, index: 0 }), { sent: false, reason: 'stale' })
  assert.equal(context.sent().length, 2)
})

test('Codex is sent nothing while its input box holds a draft, and gets no stash key', async () => {
  const typing = setupSender({ agentType: 'codex', screen: '› half a thought' })
  assert.deepEqual(await typing.send({ offer: typing.offer.id, index: 0 }), { sent: false, reason: 'typing' })
  assert.deepEqual(typing.sent(), [])
  const empty = setupSender({ agentType: 'codex' })
  assert.deepEqual(await empty.send({ offer: empty.offer.id, index: 0 }), { sent: true })
  assert.deepEqual(empty.sent(), ['PR を作ってください'])
})

test('a refused send throws and the button can be pressed again', async () => {
  const context = setupSender({ accepted: false })
  await assert.rejects(context.send({ offer: context.offer.id, index: 0 }))
  await assert.rejects(context.send({ offer: context.offer.id, index: 0 }), 'not marked as used')
})

test('the focused workspace shows its offer as cards, escaped, under its tasks', () => {
  const offer = nextOffer(worktree([agent({ lastAssistantMessage: block([proposal({ label: '<b>直す</b>', reason: '理由 & 背景' })]) })]))
  const sessions = [{ listId: 'l', cwd: '/work/app', goal: 'g', updatedAt: 1, tasks: [{ subject: 't', status: 'completed' }] }]
  const html = renderBody(buildModel({ path: '/work/app', displayName: 'app', agentStates: ['done'] }, sessions, [], [offer]))
  assert.ok(html.includes(`data-next="${offer.id}" data-index="0"`))
  assert.ok(html.includes('&lt;b&gt;直す&lt;/b&gt;'))
  assert.ok(html.includes('<span class="reason">理由 &amp; 背景</span>'))
  assert.ok(html.indexOf('class="next proposal"') > html.indexOf('<ol><li class="completed">'), 'under the tasks')
  const elsewhere = renderBody(buildModel({ path: '/work/other', displayName: 'other', agentStates: [] }, [], [], [offer]))
  assert.ok(!elsewhere.includes('data-next'), 'only the focused workspace')
  const noTasks = renderBody(buildModel({ path: '/work/app', displayName: 'app', agentStates: ['done'] }, [], [], [offer]))
  assert.ok(noTasks.includes('data-next'), 'also without tasks')
})
