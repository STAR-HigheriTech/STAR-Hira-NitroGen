import type { LooseRecord } from './type-guards.ts'

export { asRecord } from './type-guards.ts'

export type CliValue = string | true
export type CliArgs = Record<string, CliValue | undefined>

export interface ParsedArgs {
  values: CliArgs
  positional: string[]
  flags: Set<string>
}

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): ParsedArgs {
  const values: CliArgs = {}
  const positional: string[] = []
  const flags = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const separator = token.indexOf('=')
    if (separator !== -1) {
      values[token.slice(2, separator)] = token.slice(separator + 1)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values[key] = next
      index += 1
    } else {
      values[key] = true
      flags.add(key)
    }
  }

  return { values, positional, flags }
}

export function stringArg(args: CliArgs, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' ? value : undefined
}

