/* ------------------------------------------------------------------ *
 * Keep a typed-vault checkout fresh (the Knowledge Atlas, a sibling vault, …).
 *
 * The dashboard READS the vault (the `?vault=<key>` routes + the /api/tasks
 * Kanban) off its working tree. This cron keeps that checkout fresh: a plain
 * `git pull --rebase --autostash` on the registered vault, so its tab / Kanban
 * auto-update as your phone (Obsidian Git) or a knowledge agent commits to it.
 *
 * Which vault: argv[2] (a vaults.json key), default `atlas`. So the same script
 * serves every typed vault — `refresh-atlas.mjs` for atlas, `refresh-atlas.mjs
 * a sibling vault` for the recipe vault (one cron line each).
 *
 * Path resolution: $ATLAS_DIR (only for the default `atlas` key, for back-compat),
 * else the key in vaults.json (the same registry the API uses). No such vault /
 * no checkout → a clean no-op, so this is safe to schedule before the operator
 * has cloned the repo.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { listVaults } from '../api/src/vaults.mjs'

const key = process.argv[2] || 'atlas'

function vaultDir() {
  if (key === 'atlas' && process.env.ATLAS_DIR) return process.env.ATLAS_DIR
  const v = listVaults().find((x) => x.key === key)
  return v?.path || null
}

const dir = vaultDir()
if (!dir) {
  console.log(`refresh-atlas: no "${key}" vault in vaults.json${key === 'atlas' ? ' and no $ATLAS_DIR' : ''} — nothing to do`)
  process.exit(0)
}
if (!fs.existsSync(path.join(dir, '.git'))) {
  console.log(`refresh-atlas: ${dir} is not a git checkout — skipping (clone "${key}" there first)`)
  process.exit(0)
}

try {
  const out = execFileSync('git', ['-C', dir, 'pull', '--rebase', '--autostash'], {
    encoding: 'utf-8',
    timeout: 60_000,
  })
  console.log(`refresh-atlas[${key}]: ${dir} — ${out.trim().split('\n').pop()}`)
} catch (e) {
  const detail = (e.stderr || e.message || e).toString().trim()
  console.error(`refresh-atlas[${key}]: pull failed for ${dir}: ${detail}`)
  process.exit(1)
}
