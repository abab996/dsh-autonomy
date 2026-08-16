import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { AUTONOMY_LEVELS } from './levels'
import type { AutonomyLevel } from './levels'

export const AUTONOMY_SETTINGS_NAMESPACE = settingsNamespace('autonomy')

export interface AutonomySettings {
  /** Global default level for sessions without an override. */
  level: AutonomyLevel
  /**
   * Per-session overrides keyed by session id. Fallback durability channel
   * for harnesses whose `Session.append` does not honor the `ignorable`
   * option (rc.6): writing `autonomy/level` events there would make the
   * session log unreadable (unknown event type without the ignorable
   * marker), so overrides are persisted in settings instead. Once the
   * harness supports ignorable events, the plugin writes events and keeps
   * this map empty.
   */
  perSession: Record<string, AutonomyLevel>
}

const AUTONOMY_LEVEL_SCHEMA = z.union([
  z.const('strict'),
  z.const('heed'),
  z.const('normal'),
  z.const('creative'),
  z.const('wild'),
])

export const AUTONOMY_SETTINGS_SCHEMA = z.object({
  level: AUTONOMY_LEVEL_SCHEMA.default('normal'),
  perSession: z.dict(AUTONOMY_LEVEL_SCHEMA).default({}),
})

export const AUTONOMY_SETTINGS_DEFAULTS: AutonomySettings = {
  level: 'normal',
  perSession: {},
}

export function isAutonomyLevel(value: string): value is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(value)
}
