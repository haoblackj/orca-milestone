// Sends what is picked in the cards under the focused workspace. A pressed card turns to show it and
// the others stop taking presses; the worker's next body, once the agent moves on, takes the cards
// away. When nothing was sent, a line under the cards says why and they take presses again.
// - A form's options are ticked here and sent together with its button. The worker's bodies would
//   drop the ticks, so they are kept per form and put back after every patch (`restore`). So are
//   the marks of a press.
// - Allowing a dangerous command takes two presses: the first only asks for the second.
// - Cards that just came take no presses for a moment (`settling`). Answering one permission often
//   puts the next in the same place, and a quick second click would answer that one unread. So do
//   cards that moved to another place, as those of several agents do when one of these goes on.
// Listeners sit on the root, so they keep working however the cards are patched.

export const SETTLE_MS = 1500

const MESSAGES = {
  stale: 'この選択肢はもう使えません。エージェントが先に進んだか、すでに押されています。',
  typing: 'Codex の入力欄に書きかけの文字があるため、送りませんでした。',
  draft: '入力欄に書きかけの文字があるため、再開しませんでした。',
  busy: '入力欄に書きかけの文字があるため、送りませんでした。',
  forbidden: 'このボタンを押す権限がありません。接続先の daemon の allowedLogin と、この Mac の Tailscale のログインを確かめてください。',
  chat: 'このエージェントは Orca のチャットで動いているため、ここからは送れません。チャットで答えてください。',
  confirm: '危険なコマンドです。実行してよければ、もう一度押してください。',
  failed: '送信に失敗しました。'
}

/** The offer a card, an option or a form's button belongs to. */
function offerOf(element) {
  return element.getAttribute('data-next') ?? element.getAttribute('data-form') ?? element.getAttribute('data-submit')
}

/** Which button of its offer a card or a form's button is. */
function keyOf(element) {
  return element.getAttribute('data-index') ?? 'submit'
}

export function sendOnPress(root, send, { now = () => Date.now(), settleMs = SETTLE_MS, later = setTimeout } = {}) {
  // Ticks per form, by offer: an array of option sets, one per question.
  const picks = new Map()
  // When each offer on screen first showed at its place among the others, `{ at, place }`.
  const arrived = new Map()
  // The last press of each offer, `{ key, state, armed, note }`: `sending`, `sent` or `refused`.
  const presses = new Map()

  // Per offer: the cards of several agents go to terminals of their own.
  const taken = (offer) => ['sending', 'sent'].includes(presses.get(offer)?.state)
  const settling = (offer) => now() - (arrived.get(offer)?.at ?? -Infinity) < settleMs
  // Cards already there when this starts listening did not just come.
  shownOffers().forEach((offer, place) => arrived.set(offer, { at: -Infinity, place }))

  function shownOffers() {
    return [...new Set([...root.querySelectorAll('[data-next], [data-form], [data-submit]')].map(offerOf))]
  }

  /** Notes the offers that just came or moved, and marks their cards while they take no presses. */
  function settle() {
    const shown = shownOffers()
    for (const offer of arrived.keys()) if (!shown.includes(offer)) arrived.delete(offer)
    for (const [offer, press] of presses) if (!shown.includes(offer) && press.state !== 'sending') presses.delete(offer)
    for (const [place, offer] of shown.entries()) {
      if (arrived.get(offer)?.place === place) continue
      arrived.set(offer, { at: now(), place })
      later(settle, settleMs + 50)
    }
    for (const next of root.querySelectorAll('.next')) {
      const offers = [...next.querySelectorAll('[data-next], [data-form], [data-submit]')].map(offerOf)
      next.classList.toggle('settling', offers.some(settling))
    }
  }

  /** Shows what became of the presses, which a patch drops from the cards. */
  function mark() {
    for (const next of root.querySelectorAll('.next')) {
      const buttons = [...next.querySelectorAll('[data-next], [data-submit]')]
      const press = buttons.length > 0 ? presses.get(offerOf(buttons[0])) : undefined
      next.classList.toggle('busy', press?.state === 'sending' || press?.state === 'sent')
      for (const button of buttons) {
        const pressed = press?.key === keyOf(button)
        button.classList.toggle('sending', pressed && press.state !== 'refused')
        button.classList.toggle('armed', pressed && press.armed === true)
      }
      let status = next.querySelector('.status')
      if (!press?.note) {
        status?.remove()
        continue
      }
      if (!status) {
        status = next.ownerDocument.createElement('p')
        status.className = 'status'
        next.appendChild(status)
      }
      status.textContent = press.note
    }
  }

  async function deliver(element, request) {
    const press = { key: keyOf(element), state: 'sending' }
    presses.set(request.offer, press)
    restore()
    let result
    try {
      result = await send(request)
    } catch {
      result = { sent: false, reason: 'failed' }
    }
    if (result?.sent) {
      press.state = 'sent'
      picks.delete(request.offer)
    } else {
      press.state = 'refused'
      press.armed = result?.reason === 'confirm'
      press.note = MESSAGES[result?.reason] ?? MESSAGES.failed
    }
    restore()
  }

  function restore() {
    settle()
    mark()
    for (const button of root.querySelectorAll('[data-option]')) {
      const chosen = picks.get(button.getAttribute('data-form'))?.[Number(button.getAttribute('data-question'))]
      button.classList.toggle('chosen', Boolean(chosen?.has(Number(button.getAttribute('data-option')))))
    }
    for (const submit of root.querySelectorAll('[data-submit]')) {
      const chosen = picks.get(submit.getAttribute('data-submit')) ?? []
      const count = Number(submit.getAttribute('data-count'))
      submit.disabled = taken(submit.getAttribute('data-submit')) || chosen.filter((set) => set?.size > 0).length !== count
    }
  }

  function pick(option) {
    const offer = option.getAttribute('data-form')
    const position = Number(option.getAttribute('data-question'))
    const index = Number(option.getAttribute('data-option'))
    const chosen = picks.get(offer) ?? []
    const set = option.getAttribute('data-multi') === '1' ? new Set(chosen[position]) : new Set()
    if (set.has(index)) set.delete(index)
    else set.add(index)
    chosen[position] = set
    picks.set(offer, chosen)
    restore()
  }

  root.addEventListener('click', (event) => {
    const pressed = event.target.closest('[data-next], [data-form], [data-submit]')
    if (pressed && (settling(offerOf(pressed)) || taken(offerOf(pressed)))) return
    const option = event.target.closest('[data-option]')
    if (option) {
      pick(option)
      return
    }
    const submit = event.target.closest('[data-submit]')
    if (submit) {
      if (submit.disabled) return
      const offer = submit.getAttribute('data-submit')
      const answers = (picks.get(offer) ?? []).map((set) => [...set].sort((a, b) => a - b))
      void deliver(submit, { offer, answers })
      return
    }
    const card = event.target.closest('[data-next]')
    if (!card) return
    const dangerous = card.getAttribute('data-dangerous') === '1'
    if (dangerous && !card.classList.contains('armed')) {
      presses.set(offerOf(card), { key: keyOf(card), state: 'refused', armed: true, note: MESSAGES.confirm })
      restore()
      return
    }
    void deliver(card, { offer: card.getAttribute('data-next'), index: Number(card.getAttribute('data-index')), ...(dangerous ? { confirmed: true } : {}) })
  })

  return { restore }
}
