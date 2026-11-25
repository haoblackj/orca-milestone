// Brings an element's children in line with an HTML string, touching only what differs. Elements
// that stay keep their scroll position and hover state, which replacing innerHTML would lose, and
// CSS transitions run on what changes in them. An element with another data-key is something else,
// such as the list of another workspace, so it replaces the old one and shows without a transition.
// One with a data-key stays itself wherever it goes among its siblings, as rows and cards do when
// another comes before them: made anew, it would lose its hover and expansion and draw them again.

function patchAttributes(from, to) {
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name)) from.removeAttribute(name)
  }
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value)
  }
}

/** The nodes by what they are: their key or else their kind, and which of those alike. */
function byIdentity(nodes) {
  const counts = new Map()
  const found = new Map()
  for (const node of nodes) {
    const key = node.nodeType === 1 ? node.getAttribute('data-key') : null
    const kind = JSON.stringify([node.nodeType, node.nodeName, key])
    const count = counts.get(kind) ?? 0
    counts.set(kind, count + 1)
    found.set(`${kind}${count}`, node)
  }
  return found
}

/** Puts a node before another. `moveBefore` keeps what `insertBefore` resets, such as scrolling. */
function place(parent, node, before) {
  if (node.parentNode === parent && parent.moveBefore) parent.moveBefore(node, before)
  else parent.insertBefore(node, before)
}

function patchNodes(parent, wanted) {
  const current = byIdentity(parent.childNodes)
  const next = byIdentity(wanted)
  for (const [identity, node] of current) if (!next.has(identity)) parent.removeChild(node)
  let cursor = parent.firstChild
  for (const [identity, to] of next) {
    const from = current.get(identity)
    if (from && from === cursor) cursor = cursor.nextSibling
    else place(parent, from ?? to, cursor)
    if (!from) continue
    if (from.nodeType === 1) {
      patchAttributes(from, to)
      patchNodes(from, [...to.childNodes])
    } else if (from.nodeValue !== to.nodeValue) {
      from.nodeValue = to.nodeValue
    }
  }
}

export function patchChildren(element, html) {
  const template = element.ownerDocument.createElement('template')
  template.innerHTML = html
  patchNodes(element, [...template.content.childNodes])
}
