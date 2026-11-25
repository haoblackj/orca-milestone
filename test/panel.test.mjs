import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { scrollExpandedRows } from '../panel/expand.mjs'
import { openOnPress } from '../panel/open.mjs'
import { patchChildren } from '../panel/patch.mjs'

const panelDir = join(import.meta.dirname, '..', 'panel')

function body(html = '') {
  const { document } = new JSDOM('<!doctype html><body></body>').window
  document.body.innerHTML = html
  return document.body
}

test('patchChildren keeps the elements that stay and updates what differs', () => {
  const root = body('<main class="a"><p>old</p></main><div class="others"><ol><li>one</li></ol></div>')
  const [main, others] = root.children
  const list = others.querySelector('ol')
  const item = list.querySelector('li')

  patchChildren(root, '<main class="b"><p>new</p></main><div class="others"><ol><li>uno</li><li>two</li></ol></div>')

  assert.equal(root.children[0], main, 'the element is the same one')
  assert.equal(main.className, 'b')
  assert.equal(main.textContent, 'new')
  assert.equal(root.querySelector('ol'), list)
  assert.equal(list.children[0], item)
  assert.equal(item.textContent, 'uno')
  assert.equal(list.children[1].textContent, 'two')
})

test('patchChildren replaces other tags, drops extras and removes old attributes', () => {
  const root = body('<p id="x" class="y">text</p><span>a</span><span>b</span>')
  patchChildren(root, '<div class="y">text</div><span>a</span>')
  assert.equal(root.innerHTML, '<div class="y">text</div><span>a</span>')

  patchChildren(root, '<div>text</div>')
  assert.equal(root.innerHTML, '<div>text</div>')
})

test('patchChildren replaces an element whose data-key differs, and keeps one whose key is the same', () => {
  const root = body('<section data-key="a"><p>0 / 2</p></section>')
  const section = root.children[0]

  patchChildren(root, '<section data-key="a"><p>1 / 2</p></section>')
  assert.equal(root.children[0], section)
  assert.equal(section.textContent, '1 / 2')

  patchChildren(root, '<section data-key="b"><p>0 / 5</p></section>')
  assert.notEqual(root.children[0], section)
  assert.equal(root.children[0].textContent, '0 / 5')
})

test('patchChildren ends with exactly the wanted markup, from an empty panel too', () => {
  const root = body()
  const html = '<main><header><h1>app</h1></header></main><div class="others"><h2>x</h2></div>'
  patchChildren(root, html)
  assert.equal(root.innerHTML, html)
})

test('the panel document loads its stylesheet and script', async () => {
  const html = await readFile(join(panelDir, 'index.html'), 'utf8')
  assert.ok(html.includes('href="style.css"'))
  assert.ok(html.includes('src="main.mjs"'))
  await readFile(join(panelDir, 'style.css'), 'utf8')
  await readFile(join(panelDir, 'main.mjs'), 'utf8')
})

test('pressing a row head opens its workspace, also after a patch, but its detail does not', () => {
  const row = (path) =>
    `<li class="row"><div class="head" role="button" tabindex="0" data-open="${path}"><span class="name">app</span></div><div class="detail"><p>goal</p></div></li>`
  const root = body(`<ol>${row('/work/a')}</ol>`)
  const opened = []
  openOnPress(root, (path) => opened.push(path))
  const { MouseEvent, KeyboardEvent } = root.ownerDocument.defaultView
  const click = (selector) => root.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))

  click('.name')
  assert.deepEqual(opened, ['/work/a'])

  click('.detail p')
  assert.equal(opened.length, 1)

  patchChildren(root, `<ol>${row('/work/b')}</ol>`)
  click('.head')
  assert.equal(opened.at(-1), '/work/b')

  const press = (key) => root.querySelector('.head').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  press('Enter')
  press(' ')
  press('a')
  assert.equal(opened.length, 4)
})

test('the wheel over a head scrolls its tasks, and opening starts at what is left', () => {
  const root = body(
    '<li class="row"><div class="head"><span class="name">app</span></div><div class="detail"><div class="inner"><ol><li class="completed">a</li><li class="pending">b</li></ol></div></div></li><li class="row"><div class="head"><span class="name">bare</span></div></li>'
  )
  scrollExpandedRows(root)
  const { MouseEvent, WheelEvent } = root.ownerDocument.defaultView
  const inner = root.querySelector('.inner')
  root.querySelector('li.pending').getBoundingClientRect = () => ({ top: 300 })
  inner.getBoundingClientRect = () => ({ top: 100 })

  const enter = (from) => root.querySelector('.name').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
  enter(root.ownerDocument.body)
  assert.equal(inner.scrollTop, 176, 'the task left, with a little of what came before it')

  enter(inner)
  assert.equal(inner.scrollTop, 176, 'coming back from its own tasks does not jump')

  root.querySelector('.name').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
  assert.equal(inner.scrollTop, 216)

  root.querySelectorAll('.name')[1].dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
  assert.equal(inner.scrollTop, 216, 'a row with no tasks has nothing to scroll')
})

test('a pressed card is sent once, and a refusal says why and lets the cards be pressed again', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const root = body('<main><div class="next"><ol class="actions"><li><button data-next="o1" data-index="0">A</button></li><li><button data-next="o1" data-index="1">B</button></li></ol></div></main>')
  const requests = []
  let answer = { sent: false, reason: 'typing' }
  sendOnPress(root, async (request) => {
    requests.push(request)
    return answer
  })
  const [a, b] = root.querySelectorAll('[data-next]')
  b.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(requests, [{ offer: 'o1', index: 1 }])
  assert.match(root.querySelector('.status').textContent, /書きかけ/)
  assert.ok(!root.querySelector('.next').classList.contains('busy'))

  answer = { sent: true }
  a.click()
  a.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(requests.length, 2, 'a second click while one is on its way is ignored')
  assert.ok(a.classList.contains('sending'))
  assert.ok(root.querySelector('.next').classList.contains('busy'))
})

test('a card that just came in the place of the answered one takes no presses for a moment', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const { patchChildren } = await import('../panel/patch.mjs')
  const cards = (offer) => `<main><div class="next" data-key="next\n${offer}"><ol class="actions"><li><button data-next="${offer}" data-index="0">許可</button></li><li><button data-next="${offer}" data-index="1">拒否</button></li></ol></div></main>`
  const root = body('')
  let time = 0
  const timers = []
  const requests = []
  const presses = sendOnPress(root, async (request) => {
    requests.push(request)
    return { sent: true }
  }, { now: () => time, settleMs: 1500, later: (run) => timers.push(run) })
  const show = (offer) => {
    patchChildren(root, cards(offer))
    presses.restore()
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  show('first')
  assert.ok(root.querySelector('.next').classList.contains('settling'))
  root.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests, [], 'a card is not pressed before it can be read')

  time = 1500
  timers.splice(0).forEach((run) => run())
  assert.ok(!root.querySelector('.next').classList.contains('settling'))
  root.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests, [{ offer: 'first', index: 0 }])

  time = 2000
  show('second')
  assert.ok(root.querySelector('.next').classList.contains('settling'), 'the mark survives the patch')
  root.querySelector('[data-next]').click()
  await flush()
  assert.equal(requests.length, 1, 'a quick second click does not answer the next one')

  time = 2400
  show('second')
  assert.ok(root.querySelector('.next').classList.contains('settling'), 'another patch does not restart or lose the wait')
  time = 3500
  timers.splice(0).forEach((run) => run())
  root.querySelectorAll('[data-next]')[1].click()
  await flush()
  assert.deepEqual(requests[1], { offer: 'second', index: 1 })
})

test('cards that moved to another place among those of several agents take no presses for a moment', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const cards = (...offers) => `<main>${offers.map((offer) => `<div class="next" data-key="next\n${offer}"><ol class="actions"><li><button data-next="${offer}" data-index="0">続ける</button></li></ol></div>`).join('')}</main>`
  const root = body('')
  let time = 0
  const requests = []
  const presses = sendOnPress(root, async (request) => {
    requests.push(request)
    return { sent: true }
  }, { now: () => time, settleMs: 1500, later: () => {} })
  const show = (...offers) => {
    patchChildren(root, cards(...offers))
    presses.restore()
  }
  const settling = () => [...root.querySelectorAll('.next')].map((next) => next.classList.contains('settling'))

  show('a', 'b', 'c')
  time = 2000
  show('a', 'b', 'c')
  assert.deepEqual(settling(), [false, false, false])

  // The agent of `b` went on: `c` is now where `b` was.
  show('a', 'c')
  assert.deepEqual(settling(), [false, true])
  root.querySelectorAll('[data-next]')[1].click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(requests, [], 'a click meant for the card before it')

  time = 3500
  root.querySelectorAll('[data-next]')[1].click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(requests, [{ offer: 'c', index: 0 }])
})

test('while a card is sent, the cards of another agent can be pressed', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const root = body('<main><div class="next"><button data-next="a" data-index="0">A</button></div><div class="next"><button data-next="b" data-index="0">B</button></div></main>')
  const requests = []
  sendOnPress(root, (request) => {
    requests.push(request)
    return new Promise(() => {})
  })
  const [a, b] = root.querySelectorAll('[data-next]')
  a.click()
  a.click()
  b.click()
  assert.deepEqual(requests, [{ offer: 'a', index: 0 }, { offer: 'b', index: 0 }])
})

test('what became of a press stays shown when another agent’s cards come above it', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const cards = (...offers) => `<main>${offers.map((offer) => `<div class="next" data-key="next\n${offer}"><ol class="actions">${[0, 1].map((index) => `<li><button class="action" data-next="${offer}" data-index="${index}">続ける</button></li>`).join('')}</ol></div>`).join('')}</main>`
  const root = body('')
  let time = 0
  let answer
  const requests = []
  const presses = sendOnPress(root, (request) => {
    requests.push(request)
    return new Promise((resolve) => (answer = resolve))
  }, { now: () => time, settleMs: 1500, later: () => {} })
  const show = (...offers) => {
    patchChildren(root, cards(...offers))
    presses.restore()
    time += 2000
  }
  const at = (offer) => root.querySelectorAll(`[data-next="${offer}"]`)
  const next = (offer) => at(offer)[0].closest('.next')
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  show('a')
  at('a')[1].click()
  show('b', 'a')
  assert.ok(next('a').classList.contains('busy'))
  assert.deepEqual([...at('a')].map((card) => card.classList.contains('sending')), [false, true])
  assert.ok(!next('b').classList.contains('busy'))

  answer({ sent: false, reason: 'failed' })
  await flush()
  assert.match(next('a').querySelector('.status').textContent, /失敗/)
  assert.ok(!next('a').classList.contains('busy'))
  show('c', 'b', 'a')
  assert.match(next('a').querySelector('.status').textContent, /失敗/)
  assert.equal(root.querySelectorAll('.status').length, 1)

  at('a')[0].click()
  assert.equal(root.querySelectorAll('.status').length, 0, 'pressed again, the old reason is gone')
  answer({ sent: true })
  await flush()
  show('b', 'a')
  assert.ok(next('a').classList.contains('busy'), 'sent: until the agent moves on and its cards go')
  at('a')[1].click()
  assert.equal(requests.length, 2)
})

/** A panel whose sends are answered by hand, and whose offers come and go. */
async function pressPanel() {
  const { sendOnPress } = await import('../panel/next.mjs')
  const root = body('')
  const panel = { root, requests: [], answer: null, time: 0 }
  const presses = sendOnPress(root, (request) => {
    panel.requests.push(request)
    return new Promise((resolve) => (panel.answer = resolve))
  }, { now: () => panel.time, settleMs: 1500, later: () => {} })
  panel.show = (html) => {
    patchChildren(root, `<main>${html}</main>`)
    presses.restore()
    panel.time += 2000
  }
  panel.reply = async (result) => {
    panel.answer(result)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return panel
}

test('a dangerous command takes two presses again after a refusal, a redraw keeps the first, and its going away forgets it', async () => {
  const panel = await pressPanel()
  const { root, requests } = panel
  const html = '<div class="next" data-key="p"><button class="action" data-next="p" data-index="0" data-dangerous="1">許可</button><button class="action" data-next="p" data-index="1">拒否</button></div>'
  const armed = () => [...root.querySelectorAll('[data-next]')].map((card) => card.classList.contains('armed'))
  const allow = () => root.querySelector('[data-dangerous]').click()

  panel.show(html)
  allow()
  assert.deepEqual([requests.length, armed()], [0, [true, false]])
  panel.show(html)
  assert.deepEqual(armed(), [true, false])
  panel.show('')
  panel.show(html)
  assert.deepEqual([armed(), root.querySelector('.status')], [[false, false], null])

  allow()
  allow()
  assert.deepEqual(requests, [{ offer: 'p', index: 0, confirmed: true }])
  await panel.reply({ sent: false, reason: 'failed' })
  assert.deepEqual(armed(), [false, false])
  allow()
  assert.deepEqual([requests.length, armed()], [1, [true, false]], 'asks for the second press again')
  allow()
  assert.equal(requests.length, 2)
  await panel.reply({ sent: false, reason: 'confirm' })
  assert.deepEqual(armed(), [true, false])
  allow()
  assert.equal(requests.length, 3, 'the one who answers asked for this press')
})

test('cards that go away while one is sent come back still taken, and a form on its way has no button to press', async () => {
  const panel = await pressPanel()
  const { root, requests } = panel
  const card = '<div class="next" data-key="a"><button class="action" data-next="a" data-index="0">A</button></div>'
  panel.show(card)
  root.querySelector('[data-next]').click()
  panel.show('')
  panel.show(card)
  root.querySelector('[data-next]').click()
  assert.equal(requests.length, 1)
  await panel.reply({ sent: true })

  panel.show('<div class="next" data-key="f"><button class="action option" data-form="f" data-question="0" data-option="1" data-multi="0">B</button><button class="submit" data-submit="f" data-count="1" disabled>回答を送信</button></div>')
  const submit = root.querySelector('[data-submit]')
  root.querySelector('[data-option]').click()
  assert.equal(submit.disabled, false)
  submit.click()
  assert.equal(submit.disabled, true)
  await panel.reply({ sent: false, reason: 'failed' })
  assert.equal(submit.disabled, false, 'the answers are kept')
  submit.click()
  assert.deepEqual(requests.slice(1), [{ offer: 'f', answers: [[1]] }, { offer: 'f', answers: [[1]] }])
})
