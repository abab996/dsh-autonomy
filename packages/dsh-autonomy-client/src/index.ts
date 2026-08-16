// Host-plane entry for the client plugin. The browser bundle is ./client
// (loaded via the dsh.client field); this entry exists so the package resolves
// a main export on the host plane. No host behavior.
export const name = 'autonomy-client'
export const inject = [] as const
export function apply() {}
