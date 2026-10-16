import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function appDataPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32') return join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), name)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', name)
  return join(env['XDG_CONFIG_HOME'] || join(home, '.config'), name)
}

export function effectiveRoots(roots: string[] | string | undefined, defaults: string[]): string[] {
  const configured = (typeof roots === 'string' ? [roots] : roots ?? []).filter((root) => root.trim())
  return [...new Set((configured.length > 0 ? configured : defaults).map((root) => resolve(root)))]
}
