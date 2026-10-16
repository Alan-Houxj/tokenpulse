import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, rename, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { readFileSync } from 'node:fs'

const directory = resolve(process.argv[2] ?? '')
const tag = process.argv[3]
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
assert.equal(tag, `v${version}`, 'Release tag must match package.json')

const packages = [
  { name: `TokenPulse-Setup-${version}.exe`, aliases: [`TokenPulse Setup ${version}.exe`] },
  { name: `TokenPulse-${version}.exe`, aliases: [`TokenPulse ${version}.exe`] },
  { name: `TokenPulse-${version}.dmg`, aliases: [] },
  { name: `TokenPulse-${version}-arm64.dmg`, aliases: [] },
  { name: `TokenPulse-${version}.AppImage`, aliases: [] },
  { name: `tokenpulse_${version}_amd64.deb`, aliases: [] }
]
const files = await readdir(directory)
const allowed = new Set(packages.flatMap(({ name, aliases }) => [name, ...aliases]))
assert(files.every((file) => allowed.has(file)), 'Unexpected file in release artifact set')
assert.equal(files.length, packages.length, 'All six installation packages are required')

const sums = []
for (const pkg of packages) {
  const candidates = files.filter((file) => file === pkg.name || pkg.aliases.includes(file))
  assert.equal(candidates.length, 1, `Missing or duplicate package: ${pkg.name}`)
  const source = join(directory, candidates[0])
  const details = await stat(source)
  assert(details.isFile() && details.size > 1024 * 1024, `Invalid package: ${pkg.name}`)
  const destination = join(directory, pkg.name)
  if (source !== destination) await rename(source, destination)
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(destination)) hash.update(bytes)
  sums.push(`${hash.digest('hex')}  ${pkg.name}`)
  console.log(`${pkg.name}: ${details.size} bytes`)
}
await writeFile(join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
console.log('Verified six packages; SHA256SUMS.txt generated')
