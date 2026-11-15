const fs = require('fs')
const path = require('path')

type CssEntry = readonly [name: string, value: string]
interface CssBlock { selector: string; entries: CssEntry[] }
type CliArgs = Record<string, string | boolean>

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    args[key] = value
  }
  return args
}

function findMatchingBrace(css: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < css.length; i++) {
    const c = css[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function extractBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const selector = css
      .slice(i, open)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const close = findMatchingBrace(css, open)
    if (close === -1) break
    const body = css.slice(open + 1, close)
    if (body.includes('--')) {
      const entries: CssEntry[] = []
      const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g
      let m
      while ((m = re.exec(body))) {
        entries.push([`--${m[1]}`, m[2].trim()])
      }
      if (entries.length) {
        blocks.push({ selector, entries })
      }
    }
    i = close + 1
  }
  return blocks
}

function categorize(selector: string): 'base' | 'light' | 'dark' {
  const s = selector.toLowerCase()
  if (s.includes(':root')) return 'base'
  if (s.includes('light-theme')) return 'light'
  if (s.includes('dark') || s.includes('.dark-mode') || s.includes('.dark-theme')) return 'dark'
  return 'base'
}

function formatBlocks(blocks: CssBlock[]): string {
  return (
    blocks
      .map((b: CssBlock) => {
        const lines = b.entries.map(([key, value]: CssEntry) => `  ${key}: ${value};`)
        return `${b.selector} {\n${lines.join('\n')}\n}`
      })
      .join('\n\n') + '\n'
  )
}

function main() {
  const args = parseArgs(process.argv)
  const input = typeof args.input === 'string' ? args.input : path.join(process.cwd(), '..', 'dist', 'bundle.css')
  const outDir = typeof args.out === 'string' ? args.out : path.join(process.cwd(), 'packages', 'shared-ui-tokens')

  if (!fs.existsSync(input)) {
    process.stderr.write(`Missing input: ${input}\n`)
    process.exit(1)
  }

  const css = fs.readFileSync(input, 'utf8')
  const blocks = extractBlocks(css)

  const base: CssBlock[] = []
  const light: CssBlock[] = []
  const dark: CssBlock[] = []

  for (const b of blocks) {
    const c = categorize(b.selector)
    if (c === 'light') light.push(b)
    else if (c === 'dark') dark.push(b)
    else base.push(b)
  }

  fs.mkdirSync(outDir, { recursive: true })

  fs.writeFileSync(path.join(outDir, 'tokens-base.css'), formatBlocks(base), 'utf8')
  fs.writeFileSync(path.join(outDir, 'tokens-light.css'), formatBlocks(light), 'utf8')
  fs.writeFileSync(path.join(outDir, 'tokens-dark.css'), formatBlocks(dark), 'utf8')

  process.stdout.write(
    JSON.stringify(
      {
        input,
        outDir,
        blocks: blocks.length,
        baseBlocks: base.length,
        lightBlocks: light.length,
        darkBlocks: dark.length
      },
      null,
      2
    ) + '\n'
  )
}

main()
