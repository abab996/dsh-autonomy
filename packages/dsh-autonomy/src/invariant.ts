import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-autonomy'

const name = 'autonomy-invariant'
const inject = ['invariants']

const install = () => {}

const apply = (ctx: Context) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { apply, inject, name }
