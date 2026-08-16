import { apply, name, inject } from './packages/dsh-autonomy/lib/index.mjs'
import assert from 'node:assert'

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Minimal Session mock with the REAL event log contract: {type, seq, time,
 * data}. The plugin probes `String(session.append)` for the `ignorable`
 * option: the rc.6-mode append below deliberately never mentions it (rc.6
 * ignores the options bag), while the post-rc.6-mode append honors it. The
 * two bodies must stay source-distinguishable by that single token.
 */
function makeSession({ id = 'session-test', ignorableAppend = false } = {}, seedEvents = []) {
  const events = seedEvents.map((e, i) => ({ ...e, seq: i, time: Date.now() }))
  const append = ignorableAppend
    ? function append(type, data, opts) {
        const event = { type, seq: events.length, time: Date.now(), data }
        if (opts?.ignorable === true) event.ignorable = true
        events.push(event)
        return event
      }
    : function append(type, data, opts) {
        const event = { type, seq: events.length, time: Date.now(), data }
        events.push(event)
        return event
      }
  const session = {
    id,
    header: { agentPreset: 'standard' },
    events,
    append,
  }
  return session
}

const autonomyEv = (level) => ({ type: 'autonomy/level', data: { level } })

// ── apply() registrations ──────────────────────────────────────────────────

const calls = []
const sections = {}
const listeners = {}
const injects = []
const registeredCommands = []
const mountedPlugins = []

const settingsState = { level: 'normal', perSession: {} }
let watchCb = null
const settingsUpdates = []
const mockScope = {
  get: () => settingsState,
  watch: (cb) => {
    watchCb = cb
    return () => {}
  },
  update: async (patch) => {
    // Clone: dsh-settings snapshots on its side, so the mock must not share
    // the patch object with the live state (later direct mutations would
    // retroactively rewrite already-recorded updates).
    settingsUpdates.push(JSON.parse(JSON.stringify(patch)))
    Object.assign(settingsState, patch)
  },
}

const mockCtx = {
  settings: {
    register: (ns, _schema, opts) => {
      calls.push(['settings.register', ns, opts?.applies])
      return mockScope
    },
  },
  systemPrompt: { section: (s) => { calls.push(['systemPrompt.section', s.name, s.order]); sections[s.name] = s } },
  commands: { register: (d) => { calls.push(['commands.register', d.name]); registeredCommands.push(d) } },
  on: (ev, fn) => { calls.push(['on', ev]); listeners[ev] = fn },
  inject: (deps, cb) => { injects.push({ deps, cb }) },
  effect: (cb, label) => { calls.push(['effect', label]); return cb() },
  logger: { warn: () => {} },
}

assert.equal(name, 'autonomy')
assert.deepEqual(inject, ['settings', 'systemPrompt', 'commands'])
apply(mockCtx)

assert.ok(calls.some((c) => c[0] === 'settings.register' && c[1] === 'autonomy' && c[2] === 'live'), 'settings.register(autonomy) live')
assert.equal(registeredCommands.length, 1, 'host-global /autonomy command registered')
assert.equal(registeredCommands[0].name, 'autonomy')
assert.ok(calls.some((c) => c[0] === 'on' && c[1] === 'agent/created'), 'agent/created listener registered')
assert.ok(calls.some((c) => c[0] === 'on' && c[1] === 'session/disposed'), 'session/disposed listener registered')
assert.ok(injects.some((i) => i.deps.includes('sessionProjections')), 'optional projection injection')

const section = sections['autonomy:level']
assert.ok(section, 'autonomy:level section')
assert.equal(section.order, 50)

// ── agent/created: mounts the per-session command into the agent scope ─────

const created = { agent: { ctx: { plugin: (p, cfg) => { mountedPlugins.push({ p, cfg }) } } } }
listeners['agent/created']({ agent: created.agent })
assert.equal(mountedPlugins.length, 1, 'agent command plugin mounted on agent/created')
const [mounted] = mountedPlugins
assert.equal(mounted.p.name, 'autonomy-agent')
assert.deepEqual(mounted.p.inject, ['commands'])

// The mounted plugin's apply registers the same /autonomy command on the
// agent-scoped commands service.
const agentScopeCommands = []
mounted.p.apply({ commands: { register: (d) => agentScopeCommands.push(d) } })
assert.equal(agentScopeCommands.length, 1, 'agent-scoped /autonomy command registered')
assert.equal(agentScopeCommands[0].name, 'autonomy')

// ── /autonomy command behavior (shared handler) ────────────────────────────

const handler = registeredCommands[0].handler

// invalid input
const bad = await handler({ agent: { session: makeSession() }, rawInput: ' bogus ' })
assert.equal(bad.kind, 'error')

// status with no override
const statusDefault = await handler({ agent: { session: makeSession() }, rawInput: 'status' })
assert.equal(statusDefault.kind, 'success')
assert.ok(statusDefault.text.includes('normal'), 'status reports the default')

// rc.6 mode: /autonomy wild → settings per-session map, NO log event
// (writing an unmarked custom event would make the log unreadable).
const session = makeSession()
const ok = await handler({ agent: { session }, rawInput: ' wild ' })
assert.equal(ok.kind, 'success')
assert.deepEqual(session.events.filter((e) => e.type === 'autonomy/level'), [], 'rc.6: no durable log event')
assert.equal(settingsState.perSession['session-test'], 'wild', 'rc.6: override persisted in the settings map')
const statusSet = await handler({ agent: { session }, rawInput: 'status' })
assert.ok(statusSet.text.includes('session override'), 'status reports the session override')

// A second session must NOT be affected by the map override.
const other = makeSession({ id: 'session-other' })
const statusOther = await handler({ agent: { session: other }, rawInput: 'status' })
assert.equal(statusOther.kind, 'success')
assert.ok(statusOther.text.includes('following the global default'), 'other session untouched')

// reset removes the map entry; status reflects the default again.
const reset = await handler({ agent: { session }, rawInput: 'reset' })
assert.equal(reset.kind, 'success')
assert.equal(settingsState.perSession['session-test'], undefined, 'reset removes the map entry')
const statusAfterReset = await handler({ agent: { session }, rawInput: 'status' })
assert.ok(statusAfterReset.text.includes('following the global default'), 'status reflects cleared override')

// reset with no override is a no-op success.
const fresh = makeSession()
const noopReset = await handler({ agent: { session: fresh }, rawInput: 'reset' })
assert.equal(noopReset.kind, 'success')

// post-rc.6 mode: append honors ignorable → durable event, stale map pruned.
const future = makeSession({ id: 'session-future', ignorableAppend: true })
settingsState.perSession['session-future'] = 'creative' // stale entry from the rc.6 era
const okFuture = await handler({ agent: { session: future }, rawInput: 'wild' })
assert.equal(okFuture.kind, 'success')
const futureEvents = future.events.filter((e) => e.type === 'autonomy/level')
assert.equal(futureEvents.length, 1, 'event channel used on supporting harnesses')
assert.equal(futureEvents[0].ignorable, true, 'event marked ignorable')
assert.equal(settingsState.perSession['session-future'], undefined, 'stale map entry pruned once events take over')
settingsState.perSession = {}

// ── prompt section: graded texts, per-session, empty at normal ─────────────

const textFor = (session) => section.text({ agent: { session } })
assert.equal(textFor(makeSession()), '', 'normal (default) yields empty text')
assert.equal(textFor(makeSession({}, [autonomyEv('normal')])), '', 'explicit normal yields empty text')
assert.ok(textFor(makeSession({}, [autonomyEv('strict')])).includes('STRICT'), 'strict directive')
assert.ok(textFor(makeSession({}, [autonomyEv('heed')])).includes('HEED'), 'heed directive')
assert.ok(textFor(makeSession({}, [autonomyEv('creative')])).includes('CREATIVE'), 'creative directive')
assert.ok(textFor(makeSession({}, [autonomyEv('wild')])).includes('WILD'), 'wild directive')
assert.ok(textFor(makeSession({}, [autonomyEv('wild')])).includes('state your intent in one line first'), 'wild: announce intent before adding')
assert.equal(textFor(undefined), '', 'no session → no directive')

// rc.6 map override drives the directive too.
settingsState.perSession = { 'session-map': 'strict' }
assert.ok(textFor(makeSession({ id: 'session-map' })).includes('STRICT'), 'map override applies')
// ...but the last event beats the map when both exist.
assert.ok(textFor(makeSession({ id: 'session-map' }, [autonomyEv('wild')])).includes('WILD'), 'last event beats the map')
settingsState.perSession = {}

// Override wins over the settings default.
settingsState.level = 'creative'
assert.ok(textFor(makeSession({}, [autonomyEv('strict')])).includes('STRICT'), 'override beats default')
settingsState.level = 'normal'

// Last event wins; a trailing null falls back to the default.
assert.ok(textFor(makeSession({}, [autonomyEv('wild'), autonomyEv('strict')])).includes('STRICT'), 'last event wins')
assert.equal(textFor(makeSession({}, [autonomyEv('wild'), autonomyEv(null)])), '', 'trailing null clears the override')

// ── session/disposed: prune the per-session map ────────────────────────────

settingsState.perSession = { 'session-a': 'wild', 'session-b': 'heed' }
listeners['session/disposed']({ id: 'session-a' })
assert.deepEqual(settingsState.perSession, { 'session-b': 'heed' }, 'disposed session entry pruned')
listeners['session/disposed']({ id: 'session-c' })
assert.deepEqual(settingsState.perSession, { 'session-b': 'heed' }, 'dispose without an override is a no-op')
settingsState.perSession = {}

// ── projection: folds autonomy/level events into the client-visible value ──

const projReg = injects.find((i) => i.deps.includes('sessionProjections'))
const registered = []
const mockSctx = {
  sessionProjections: { register: (def) => { registered.push(def); return () => {} } },
}
projReg.cb(mockSctx)
assert.equal(registered.length, 1, 'autonomy projection registered')
const proj = registered[0]
assert.equal(proj.key, 'autonomy')
assert.deepEqual(proj.init(), { level: null }, 'init: null = inherits default')
const evt = { type: 'autonomy/level', seq: 5, time: 0, data: { level: 'creative' } }
assert.deepEqual(proj.apply({ level: null }, evt), { level: 'creative' }, 'apply folds the override')
const resetEvt = { type: 'autonomy/level', seq: 6, time: 0, data: { level: null } }
assert.deepEqual(proj.apply({ level: 'creative' }, resetEvt), { level: null }, 'apply folds the reset')
const unrelatedState = { level: null }
assert.strictEqual(proj.apply(unrelatedState, { type: 'turn/start', seq: 1, time: 0, data: {} }), unrelatedState, 'unrelated events return the same state reference')
const wrongType = { level: null }
assert.strictEqual(proj.apply(wrongType, { type: 'sandbox/mode', seq: 2, time: 0, data: { mode: 'read-only' } }), wrongType, 'other event types ignored')

console.log('ALL host apply() smoke tests PASSED')
console.log('settings updates:', JSON.stringify(settingsUpdates))
console.log('calls:', calls.map((c) => c.slice(0, 2).join(':')).join(' | '))
