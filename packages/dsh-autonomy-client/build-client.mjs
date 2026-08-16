// build-client.mjs — bundle src/client.tsx into the dsh client-loader handoff
// format: a script that registers itself via window.__ModuleLoader__.load({
// id, factory }). The factory receives the loader's synchronous require; all
// dsh/@deepseek-ai deps and react stay external (seed words / shell-own
// statics, mirroring the official client-plugin bundles).
//
// Run after tsdown (which emits the .d.mts types + the host-plane index).
import { rolldown } from 'rolldown'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const HANDOFF_ID = 'dsh-autonomy-client'

const banner = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(HANDOFF_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`

const footer = `
		return module.exports;
	}
});`

const bundle = await rolldown({
  input: join(root, 'src', 'client.tsx'),
  platform: 'browser',
  transform: { jsx: 'react-jsx' },
  external: [/^react$/, /^react\//, /^@deepseek-ai\//],
})

await bundle.write({
  format: 'cjs',
  file: join(root, 'lib', 'client.js'),
  banner,
  footer,
  sourcemap: false,
})
console.log('lib/client.js written (ModuleLoader handoff bundle)')
