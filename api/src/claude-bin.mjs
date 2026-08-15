/* ------------------------------------------------------------------ *
 * Where `claude` actually is — resolved ONCE, as an ABSOLUTE path.
 *
 * THE FIELD BUG THIS EXISTS FOR. `npm i -g @anthropic-ai/claude-code` puts the
 * binary wherever npm's prefix points — on a real install that was
 * `~/.local/bin/claude`. An INTERACTIVE `scripts/serve.sh restart` inherits the
 * operator's full login PATH, finds it, and everything works. The same restart
 * driven by the two-minute watchdog cron (/etc/cron.d, whose PATH is
 * `/usr/local/bin:/usr/bin:/bin`) or by systemd (an even barer PATH) does NOT
 * have that directory — so every
 * `claude` child the API spawns afterwards dies with ENOENT, and the only symptom
 * is agents that never start. "Works when I restart it by hand, breaks when the
 * watchdog does" is the shape.
 *
 * The structural fix is to stop relying on the ambient PATH at spawn time:
 * resolve one absolute path here and hand THAT to every spawn site
 * (agent-local.mjs's tmux launch templates, agent-titles.mjs, and the addons'
 * `claude -p` callers). Search order:
 *
 *   1. CLAUDE_BIN            — explicit override, AUTHORITATIVE. If it is set and
 *                              unusable we refuse; we never quietly fall through
 *                              to a different binary than the operator named.
 *   2. $PATH                 — `command -v claude`, in PATH order.
 *   3. $HOME/.local/bin/claude
 *   4. /usr/local/bin/claude
 *
 * Unresolvable is LOUD, never silent: the API prints a refusal banner at boot
 * (see reportClaudeBinAtBoot), `GET /api/health` carries `claude: { ok: false, … }`,
 * and every spawn site refuses with that reason instead of an ENOENT nobody reads.
 * The process does NOT exit — a dashboard that dies on a missing CLI would just
 * restart-loop under the same watchdog, taking down the vault UI, the Kanban and
 * the health endpoint that is supposed to TELL you what's wrong.
 *
 * Belt and braces: the PATH lines the kit writes into cron/systemd (see
 * cronPathValue below, infra/atlas-kit.cron, scripts/addon-cron.mjs,
 * scripts/serve.sh, scripts/provision-hetzner.sh) also carry ~/.local/bin, so a
 * kit that never reached this resolver still finds the binary.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = 'claude'
// Searched after $PATH, in this order. `~` is the resolving user's home.
export const FALLBACK_DIRS = ['~/.local/bin', '/usr/local/bin']

/** Default probe: an existing, executable regular file (a dangling symlink fails
 * statSync, which is what we want — a broken /usr/local/bin/claude is not a hit). */
function executable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Pure, injectable resolution — the hermetic-test seam (fake env/home/probe).
 * → { ok: true, path, source } | { ok: false, error, tried: string[] } */
export function resolveClaudeBin({ env = process.env, home = os.homedir(), isExecutable = executable } = {}) {
  const override = String(env.CLAUDE_BIN || '').trim()
  if (override) {
    if (!path.isAbsolute(override))
      return { ok: false, tried: [override], error: `CLAUDE_BIN must be an ABSOLUTE path — got "${override}"` }
    if (!isExecutable(override))
      return { ok: false, tried: [override], error: `CLAUDE_BIN="${override}" is not an executable file` }
    return { ok: true, path: override, source: 'CLAUDE_BIN' }
  }

  const tried = []
  const probe = (p, source) => {
    if (!p || tried.includes(p)) return null
    tried.push(p)
    return isExecutable(p) ? { ok: true, path: p, source } : null
  }
  // `command -v claude`, done in-process: PATH order, resolved to absolute so a
  // relative PATH entry can never yield a cwd-dependent launch command.
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const hit = probe(path.resolve(dir, BIN), 'PATH')
    if (hit) return hit
  }
  for (const dir of FALLBACK_DIRS) {
    const abs = dir.startsWith('~/') ? (home ? path.join(home, dir.slice(2)) : '') : dir
    const hit = probe(abs && path.join(abs, BIN), 'fallback')
    if (hit) return hit
  }
  return {
    ok: false,
    tried,
    error:
      `\`${BIN}\` not found on PATH, in ~/.local/bin or in /usr/local/bin. ` +
      `Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code), or set CLAUDE_BIN to its absolute path.`,
  }
}

/* Resolved once per process, LAZILY — a test (or an addon's install script) that
 * puts a stub on PATH before the first spawn still gets it. */
let cached = null
export function claudeBinInfo() {
  if (!cached) cached = resolveClaudeBin()
  return cached
}
/** The absolute path, or null when unresolvable. */
export function claudeBin() {
  const info = claudeBinInfo()
  return info.ok ? info.path : null
}
/** The absolute path, or a throw carrying WHY — for `spawn()` call sites. */
export function requireClaudeBin() {
  const info = claudeBinInfo()
  if (!info.ok) throw new Error(`claude CLI unavailable: ${info.error}`)
  return info.path
}
/** POSIX-quoted, for embedding in a `sh -lc` launch command. Falls back to the
 * bare name so an unresolved kit still builds a well-formed command string — the
 * spawn paths refuse before it is ever run. */
export function claudeShellWord() {
  const p = claudeBin()
  return p ? "'" + p.replace(/'/g, "'\\''") + "'" : BIN
}
/** The `claude` block on GET /api/health. */
export function claudeBinHealth() {
  const info = claudeBinInfo()
  if (info.ok) return { ok: true, path: info.path, source: info.source }
  return { ok: false, error: info.error, searched: info.tried.slice(0, 12) }
}
/** Boot-time report: one line when resolved, a refusal banner when not. Returns
 * whether it resolved. `log` is injectable so the banner is testable. */
export function reportClaudeBinAtBoot(log = console.error) {
  const info = claudeBinInfo()
  if (info.ok) {
    log(`[claude-bin] ${info.path} (via ${info.source})`)
    return true
  }
  log(
    [
      '',
      '  ╔══════════════════════════════════════════════════════════════════╗',
      '  ║  REFUSING TO RUN AGENTS: the claude CLI could not be resolved.   ║',
      '  ╚══════════════════════════════════════════════════════════════════╝',
      `  ${info.error}`,
      `  Looked at: ${info.tried.slice(0, 12).join(', ') || '(nothing — empty PATH)'}`,
      '  Every agent spawn and every `claude -p` worker will refuse with this',
      '  reason until it is fixed. GET /api/health reports it as claude.ok=false.',
      '',
    ].join('\n'),
  )
  return false
}
/** Test-only: drop the memoized resolution. */
export function resetClaudeBinCache() {
  cached = null
}

/** The PATH value for a cron file the kit writes (/etc/cron.d/*).
 *
 * Cron does NOT expand variables in its `PATH=` line — `$HOME/.local/bin` there
 * is a literal directory named `$HOME`, not the home dir — so the path has to be
 * baked in. Prepended like Debian's own ~/.profile does, so a user-local install
 * wins over a stale system-wide one. */
export function cronPathValue(home = os.homedir()) {
  const dirs = ['/usr/local/bin', '/usr/bin', '/bin']
  if (home) dirs.unshift(path.join(home, '.local', 'bin'))
  return dirs.join(':')
}
