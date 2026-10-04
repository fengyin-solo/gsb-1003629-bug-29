// 用 esbuild 把带 @ 别名的 TS 测试打成临时 ESM 再运行。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(root, 'scripts/drone-domain.test.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(root, 'node_modules/.cache/drone-domain.test.bundle.mjs'),
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})

await import(path.join(root, 'node_modules/.cache/drone-domain.test.bundle.mjs'))
