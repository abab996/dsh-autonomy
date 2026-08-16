import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  dts: true,
})
