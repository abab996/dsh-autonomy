import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
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

/** The session's last autonomy/level override, or undefined when none (incl. after a reset). */
function overrideLevel(session: Session): AutonomyLevel | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event.type !== EVENT_TYPE) continue
    const level = event.data.level
    return level === null ? undefined : level
  }
  return undefined
}

/**
 * One /autonomy handler shared by the host-global command and the per-session
 * command mounted into each agent scope: appends a durable autonomy/level
 * event to THAT session's log (per-session, survives restart/resume).
 */
function autonomyHandler(
  invocation: CommandInvocation,
  defaultLevel: () => AutonomyLevel,
): CommandResult {
  const raw = invocation.rawInput.trim().toLowerCase()
  const session = invocation.agent.session
  const current = overrideLevel(session)
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
    session.append(EVENT_TYPE, { level: null })
    return { kind: 'success', text: `Autonomy level reset to the global default (${defaultLevel()})` }
  }
  if (!isAutonomyLevel(raw)) {
    return { kind: 'error', text: 'Usage: /autonomy [strict|heed|normal|creative|wild|reset|status]' }
  }
  session.append(EVENT_TYPE, { level: raw })
  return { kind: 'success', text: `Autonomy level: ${raw}` }
}

const COMMAND_DESCRIPTION =
  "set this session's autonomy level (strict | heed | normal | creative | wild), reset to default, or show status"
const COMMAND_HINT = '[strict|heed|normal|creative|wild|reset|status]'

export function apply(ctx: Context) {
  const scope = ctx.settings.register<AutonomySettings>(AUTONOMY_SETTINGS_NAMESPACE, AUTONOMY_SETTINGS_SCHEMA, {
    applies: 'live',
  })
  const defaultLevel = (): AutonomyLevel => scope.get().level

  // Host-global command: reachable from chat input / the CLI. The web
  // client's command channel (remote.commands.execute) dispatches into the
  // SESSION's agent command registry — omd verified host-plane registrations
  // are unreachable there — so the per-session copy below is what the
  // composer slider reaches.
  ctx.commands.register({
    name: 'autonomy',
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    handler: (invocation) => autonomyHandler(invocation, defaultLevel),
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
        handler: (invocation) => autonomyHandler(invocation, defaultLevel),
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
      return AUTONOMY_LEVEL_PROMPTS[overrideLevel(session) ?? defaultLevel()]
    },
  })

  // Mirror the per-session override to the web client (optional service:
  // headless assemblies without the registry just skip the projection).
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
