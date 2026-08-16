import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { AUTONOMY_LEVELS } from './levels'
import type { AutonomyLevel } from './levels'

export const AUTONOMY_SETTINGS_NAMESPACE = settingsNamespace('autonomy')

export interface AutonomySettings {
  /** Global default level for sessions without an override. */
  level: AutonomyLevel
}

export const AUTONOMY_SETTINGS_SCHEMA = z.object({
  level: z
    .union([
      z.const('strict'),
      z.const('heed'),
      z.const('normal'),
      z.const('creative'),
      z.const('wild'),
    ])
    .default('normal'),
})

export const AUTONOMY_SETTINGS_DEFAULTS: AutonomySettings = {
  level: 'normal',
}

export function isAutonomyLevel(value: string): value is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(value)
}
