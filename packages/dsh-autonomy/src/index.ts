import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { AUTONOMY_SETTINGS_NAMESPACE, AUTONOMY_SETTINGS_SCHEMA, isAutonomyLevel } from './settings'
import type { AutonomySettings } from './settings'
import { AUTONOMY_LEVEL_PROMPTS } from './levels'
import type { AutonomyLevel } from './levels'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Per-session autonomy override; `level: null` clears it back to the global default. */
    'autonomy/level': { level: AutonomyLevel | null }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-session autonomy override mirrored to the web client (null = inherits the settings default). */
    autonomy: { level: AutonomyLevel | null }
  }
}

export const name = 'autonomy'
export const inject = ['settings', 'systemPrompt', 'commands']

const EVENT_TYPE = 'autonomy/level'

/**
 * Whether the running harness's `Session.append` honors the `ignorable`
 * options-bag marker. Harnesses at rc.6 ignore the options bag entirely: a
 * custom event written there comes out UNMARKED, and the persistence reader
 * refuses unknown required event types (SessionFormatUnsupportedError) —
 * writing `autonomy/level` events on rc.6 makes the whole session log
 * unreadable. The marker support landed post-rc.6 (the append implementation
 * then reads the option). The probe inspects the append implementation
 * itself, so it is deterministic and side-effect free (no probe event is
 * ever appended).
 */
function appendHonorsIgnorable(session: Session): boolean {
  try {
    return String(session.append).includes('ignorable')
  } catch {
    return false
  }
}

/** Append the override as a durable session event marked ignorable. */
function appendAutonomyLevel(session: Session, level: AutonomyLevel | null): void {
  const appendWithOptions = session as unknown as {
    append(type: string, data: unknown, options?: { ignorable?: true }): SessionEvent
  }
  appendWithOptions.append(EVENT_TYPE, { level }, { ignorable: true })
}

/**
 * The session's effective override: the last `autonomy/level` event wins
 * (including an explicit null reset), otherwise the settings per-session map
 * (rc.6 fallback channel), otherwise undefined = follow the global default.
 */
function overrideLevel(
  session: Session,
  perSession: Record<string, AutonomyLevel>,
): AutonomyLevel | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event.type !== EVENT_TYPE) continue
    const level = event.data.level
    return level === null ? undefined : level
  }
  return perSession[session.id]
}

/**
 * One /autonomy handler shared by the host-global command and the per-session
 * command mounted into each agent scope. Writes go through the caller's
 * setOverride, which picks the durable channel the harness supports.
 */
function autonomyHandler(
  invocation: CommandInvocation,
  defaultLevel: () => AutonomyLevel,
  perSession: () => Record<string, AutonomyLevel>,
  setOverride: (session: Session, level: AutonomyLevel | null) => Promise<void>,
): CommandResult | Promise<CommandResult> {
  const raw = invocation.rawInput.trim().toLowerCase()
  const session = invocation.agent.session
  const current = overrideLevel(session, perSession())
  if (raw === 'status') {
    return {
      kind: 'success',
      text:
        `Autonomy level: ${current ?? defaultLevel()}` +
        (current === undefined ? ' (following the global default)' : ' (session override)'),
    }
  }
  if (raw === 'reset') {
    if (current === undefined) {
      return { kind: 'success', text: `Autonomy level: following the global default (${defaultLevel()})` }
    }
    return setOverride(session, null).then(() => ({
      kind: 'success',
      text: `Autonomy level reset to the global default (${defaultLevel()})`,
    }))
  }
  if (!isAutonomyLevel(raw)) {
    return { kind: 'error', text: 'Usage: /autonomy [strict|heed|normal|creative|wild|reset|status]' }
  }
  return setOverride(session, raw).then(() => ({ kind: 'success', text: `Autonomy level: ${raw}` }))
}

const COMMAND_DESCRIPTION =
  "set this session's autonomy level (strict | heed | normal | creative | wild), reset to default, or show status"
const COMMAND_HINT = '[strict|heed|normal|creative|wild|reset|status]'

export function apply(ctx: Context) {
  const scope = ctx.settings.register<AutonomySettings>(AUTONOMY_SETTINGS_NAMESPACE, AUTONOMY_SETTINGS_SCHEMA, {
    applies: 'live',
  })
  const defaultLevel = (): AutonomyLevel => scope.get().level
  const perSession = (): Record<string, AutonomyLevel> => scope.get().perSession ?? {}

  /**
   * Durable per-session write: prefer the native session event on harnesses
   * that honor the `ignorable` marker (the override then lives in the session
   * log, feeds the projection, and replays across restarts); otherwise
   * persist in the settings per-session map — the one channel that stays
   * readable on rc.6.
   */
  const setOverride = async (session: Session, level: AutonomyLevel | null): Promise<void> => {
    if (appendHonorsIgnorable(session)) {
      appendAutonomyLevel(session, level)
      // Events are now the source of truth: drop any stale map entry so the
      // map never shadows a newer event-based reset.
      const map = perSession()
      if (session.id in map) {
        const next = { ...map }
        delete next[session.id]
        await scope.update({ perSession: next })
      }
      return
    }
    const map = perSession()
    const next = { ...map }
    if (level === null) delete next[session.id]
    else next[session.id] = level
    await scope.update({ perSession: next })
  }

  // Host-global command: reachable from chat input / the CLI. The web
  // client's command channel (remote.commands.execute) dispatches into the
  // SESSION's agent command registry — omd verified host-plane registrations
  // are unreachable there — so the per-session copy below is what the
  // composer slider reaches.
  ctx.commands.register({
    name: 'autonomy',
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    handler: (invocation) => autonomyHandler(invocation, defaultLevel, perSession, setOverride),
  })

  // Per-session command: mounted into each agent's scope on agent/created.
  // agent.ctx.plugin() is the same composition mechanism the cordis runtime
  // uses for dynamic plugins; the fiber rides the agent scope and is disposed
  // with it, so every fresh or resumed agent gets exactly one copy and no
  // stale copy survives an agent rebuild. Shadowing the host-global
  // registration of the same name is the documented CommandRuntime layering.
  const agentCommandPlugin = {
    name: 'autonomy-agent',
    inject: ['commands'],
    apply: (actx: Context) => {
      actx.commands.register({
        name: 'autonomy',
        description: COMMAND_DESCRIPTION,
        input: { hint: COMMAND_HINT },
        handler: (invocation) => autonomyHandler(invocation, defaultLevel, perSession, setOverride),
      })
    },
  }
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.plugin(agentCommandPlugin)
  })

  // Graded directive, re-evaluated on every assembly — a slider change takes
  // effect on the next model request without a restart. "normal" yields an
  // empty section (dropped by rendering) = zero interference.
  ctx.systemPrompt.section({
    name: 'autonomy:level',
    order: 50,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      return AUTONOMY_LEVEL_PROMPTS[overrideLevel(session, perSession()) ?? defaultLevel()]
    },
  })

  // The per-session map grows with session ids; drop the entry when a
  // session is disposed so the settings document does not accumulate stale
  // keys (no write when the session had no override).
  ctx.on('session/disposed', (session) => {
    const map = perSession()
    if (!(session.id in map)) return
    const next = { ...map }
    delete next[session.id]
    void scope.update({ perSession: next }).catch((error: unknown) => {
      ctx.logger?.warn?.('[autonomy] failed to prune perSession entry:', error)
    })
  })

  // Mirror the per-session override to the web client (optional service:
  // headless assemblies without the registry just skip the projection). The
  // fold covers the event channel; on rc.6 hosts (no events) the client
  // falls back to the settings per-session map itself.
  ctx.inject(['sessionProjections'], (sctx) => {
    sctx.sessionProjections.register({
      key: 'autonomy',
      schema: z.object({
        level: z.union([
          z.literal('strict'),
          z.literal('heed'),
          z.literal('normal'),
          z.literal('creative'),
          z.literal('wild'),
          z.literal(null),
        ]),
      }),
      init: (): { level: AutonomyLevel | null } => ({ level: null }),
      apply: (state, event) => {
        const e = event as { type?: string; data?: { level?: AutonomyLevel | null } }
        if (e.type !== EVENT_TYPE) return state
        return { level: e.data?.level ?? null }
      },
      view: (state) => state,
      stateVersion: 1,
    })
  })
}
