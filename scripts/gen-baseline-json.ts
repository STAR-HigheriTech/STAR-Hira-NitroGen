import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs, stringArg } from './lib/cli'

function main(): void {
  const { values } = parseArgs(process.argv.slice(2))
  const dir = stringArg(values, 'dir')
  if (!dir) {
    process.stderr.write('Missing --dir\n')
    process.exit(1)
  }

  const absDir = path.resolve(dir)
  if (!fs.existsSync(absDir)) {
    process.stderr.write(`Missing dir: ${absDir}\n`)
    process.exit(1)
  }

  const files = fs.readdirSync(absDir).filter((file: string) => file.toLowerCase().endsWith('.png'))
  let created = 0
  let skipped = 0

  for (const pngName of files) {
    const jsonName = pngName.replace(/\.png$/i, '.json')
    const jsonPath = path.join(absDir, jsonName)
    if (fs.existsSync(jsonPath)) {
      skipped++
      continue
    }

    const obj = {
      windowSize: { w: 1100, h: 720 },
      profile: 'default',
      description: pngName.replace(/\.png$/i, ''),
      steps: []
    }

    fs.writeFileSync(jsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    created++
  }

  process.stdout.write(JSON.stringify({ dir: absDir, png: files.length, created, skipped }, null, 2) + '\n')
}

main()
