// test-client-apply.mjs — run the REAL shipped browser bundle (lib/client.js,
// the window.__ModuleLoader__ handoff format) inside a VM with stubbed
// require(), then exercise apply() against a mock client ctx.
//
// This is deliberately NOT an import of lib/client.mjs: the shipped browser
// artifact is lib/client.js — exactly what the browser executes.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert'

const bundleSource = readFileSync(new URL('./packages/dsh-autonomy-client/lib/client.js', import.meta.url), 'utf8')

// ── stub the loader + the external seeds the bundle requires ───────────────
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useRef: (init) => ({ current: init }),
  useSyncExternalStore: (_sub, get) => get(),
  Fragment: 'Fragment',
}
const primitivesStub = {
  Button: 'Button',
  IconChevronDownOutline14: 'IconChevronDownOutline14',
}

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (spec) => { loaded = spec },
    },
  },
  console,
}
vm.createContext(sandbox)
vm.runInContext(bundleSource, sandbox)

assert.ok(loaded, 'bundle registered via window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-autonomy-client')

const requireFn = (spec) => {
  if (spec === 'react') return reactStub
  if (spec === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: 'Fragment',
    }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error('unexpected require: ' + spec)
}
const mod = loaded.factory(requireFn)
assert.ok(mod, 'factory produced module exports')

// ── exports ────────────────────────────────────────────────────────────────
assert.equal(mod.name, 'autonomy-client')
// `remote.commands` is load-bearing: without it the typert namespace is not
// mounted and `ctx.remote.commands.execute` throws (the same trap the OMD
// switcher hit).
assert.deepEqual(mod.inject, ['slots', 'settingsScope', 'remote', 'remote.commands'])

// ── apply() registrations ──────────────────────────────────────────────────
const registered = []
const injected = []
let bound = null
let commandOk = false
const commandLines = []

const mockCtx = {
  settingsScope: {
    bind: (spec) => {
      bound = spec.namespace
      return {
        subscribe: () => () => {},
        getSnapshot: () => ({ status: 'ready', value: { level: 'normal' } }),
      }
    },
  },
  slots: {
    inject: (key, cb) => { injected.push({ key, cb }) },
    register: (opts, render) => { registered.push({ opts, render }) },
  },
  remote: {
    commands: {
      execute: async (sessionId, line) => {
        commandLines.push([sessionId, line])
        return commandOk
          ? { ok: true, value: { commandId: 'cmd-1', result: { kind: 'success' } } }
          : { ok: false, error: { code: 'test', message: 'command channel down' } }
      },
    },
  },
}
mockCtx.root = mockCtx

mod.apply(mockCtx)

assert.equal(bound, 'autonomy', 'settings namespace bound')
assert.deepEqual(injected.map((i) => i.key), ['conversation.input.right'], 'composer slot deferred via slots.inject')

// Run the deferred registration exactly like the slot core would once the
// declaration is committed.
for (const entry of injected) entry.cb()

assert.equal(registered.length, 1)
const slot = registered[0]
assert.equal(slot.opts.name, 'conversation.input.right', 'targets the composer tool row')
assert.equal(slot.opts.id, 'autonomy')
assert.equal(slot.opts.label, '自主性')
assert.equal(slot.opts.order, 1000, 'highest order → immediately left of the model seat')

// ── render + switch path ───────────────────────────────────────────────────
const render = slot.render
const tree = render({ sessionId: 'session-1', useProjection: () => null })
assert.ok(tree, 'slider control rendered')
assert.equal(typeof tree.props.setLevel, 'function', 'setLevel wired')

// Command channel down → the failure surfaces (⚠ mark), never silent.
const fail = await tree.props.setLevel('wild')
assert.equal(fail.ok, false, 'command failure surfaces')
assert.ok(typeof fail.message === 'string' && fail.message.length > 0, 'failure carries the error')
assert.deepEqual(commandLines, [['session-1', '/autonomy wild']], 'command line routed to the session')

// Command channel up → the switch succeeds.
commandOk = true
const ok = await tree.props.setLevel('creative')
assert.deepEqual(ok, { ok: true }, 'switch succeeds when the agent-plane /autonomy answers')
assert.deepEqual(commandLines.slice(-1), [['session-1', '/autonomy creative']], 'level routed per session')

// Reset route.
const reset = await tree.props.setLevel('reset')
assert.deepEqual(reset, { ok: true }, 'reset succeeds')
assert.deepEqual(commandLines.slice(-1), [['session-1', '/autonomy reset']], 'reset routed')

console.log('ALL client apply() smoke tests PASSED (real handoff bundle, VM)')
console.log('slots:', registered.map((r) => r.opts.name).join(', '))
