import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', client: 'src/client.tsx' },
  outDir: 'lib',
  dts: true,
})
