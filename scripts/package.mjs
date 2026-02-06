import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist')

if (!fs.existsSync(distDir)) {
  throw new Error('dist/ not found. Run `npm run build` first.')
}

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const version = pkg.version
const outName = `ai-translate-assistant-${version}.zip`
const outPath = path.join(projectRoot, outName)

if (fs.existsSync(outPath)) fs.rmSync(outPath)

execFileSync('zip', ['-r', outPath, '.'], {
  cwd: distDir,
  stdio: 'inherit',
})

console.log(`Created ${outName}`)
