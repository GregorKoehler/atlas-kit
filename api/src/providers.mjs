/* ------------------------------------------------------------------ *
 * Provider profiles — named model-BACKEND presets for a spawn.
 *
 * An agent always runs the same Claude-Code harness — a dev agent and a
 * knowledge/Atlas chat alike: the same tmux session, the same `ATLAS:` markers,
 * the same lifecycle machine, the same MCP config, the same prompt. A PROFILE
 * changes only WHICH BACKEND that harness talks to, by handing the agent's
 * process a block of environment variables — an Anthropic-compatible base URL, a
 * token, and the tier→model mapping. Nothing else about the spawn differs, which
 * is the whole point: no second agent CLI, no parallel runtime.
 *
 * 🔴 THE ENV BLOCK IS OPAQUE. The kit hardcodes NO provider list and knows no
 * provider's variable names — it reads `env` and injects it verbatim. That is
 * the same open-world shape addons have: a backend the kit has never heard of
 * works if the operator can describe it as environment variables.
 *
 * 🔴 ZERO PROFILES MUST BE ZERO COST. With no `providers.json` and no `provider`
 * on a spawn, `listProviders()` is empty and the launch line is byte-identical
 * to what it was before profiles existed. See the {claudeEnv} slot in
 * agent-local.mjs for the one place that holds.
 *
 * 🔴 VALUES ARE SECRETS. `listProviders()` — what `GET /api/providers` and the
 * spawn dropdown are built on — returns names and labels ONLY. A profile's `env`
 * leaves this module through `resolveProvider()` alone, and its one consumer
 * (`providerEnvPrefix()` in agent-local.mjs) writes it to a 0600 file the agent's
 * own shell sources and deletes before `claude` starts — never on a command line,
 * in a response, in a log or in the audit journal. Passing it as
 * `tmux new-session -e NAME=value` was the obvious implementation and is
 * deliberately NOT what happens: that is an argv, `ps` shows an argv to every
 * user on the box, and the tmux SERVER a first spawn starts keeps that argv for
 * its whole life.
 *
 * CONFIG, two ways (mirroring vaults.json / bridges.json):
 *   api/src/providers.json          gitignored, operator-local, holds the keys
 *   ATLAS_PROVIDERS_FILE=/path      override (used by the tests)
 * `providers.example.json` is the checked-in template. Re-read per call, so
 * editing a profile needs no restart.
 *
 * See docs/PROVIDERS.md for the setup, the tier mapping and the caveats.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REGISTRY_FILE = process.env.ATLAS_PROVIDERS_FILE || path.join(HERE, 'providers.json')

/* A profile name reaches this module from an API request and is echoed into the
 * audit log and a session record, so it is validated rather than trusted:
 * lowercase, digits and dashes — the same shape an addon name has. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
/* An env NAME a shell will accept. A value that is not a string, or that carries
 * a newline or a NUL, is rejected: a NUL cannot go in an environment variable at
 * all, and a newline in a credential is a mis-pasted key every time — caught
 * here, at config time, rather than as a confusing auth error at the agent's
 * first turn. (The value itself is shell-quoted on the way out, so this is a
 * sanity check on the operator's file, not an escaping requirement.) */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function readFileJson() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {
    /* no file, or an unreadable one → no profiles, which is the default */
  }
  return {}
}

/** One profile entry → { label, env }, or null when it is malformed. */
function normalize(name, raw) {
  if (!NAME_RE.test(name)) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw.env
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null
  const env = {}
  for (const [k, v] of Object.entries(src)) {
    if (!ENV_NAME_RE.test(k)) return null
    if (typeof v !== 'string' || /[\n\0]/.test(v)) return null
    env[k] = v
  }
  return { label: typeof raw.label === 'string' && raw.label ? raw.label : name, env }
}

/** Every VALID profile, keyed by name. Malformed entries are dropped, not thrown. */
function load() {
  const out = {}
  for (const [name, raw] of Object.entries(readFileJson())) {
    const p = normalize(name, raw)
    if (p) out[name] = p
  }
  return out
}

/**
 * [{ name, label }] — what the dropdown and `GET /api/providers` are built on.
 * ⚠️ NEVER add `env` here: this shape is what keeps a key out of every response,
 * every log line and the browser.
 */
export function listProviders() {
  return Object.entries(load())
    .map(([name, p]) => ({ name, label: p.label }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a name → { name, label, env }, or null when it is not configured. */
export function resolveProvider(name) {
  if (!name || typeof name !== 'string') return null
  const p = load()[name]
  return p ? { name, label: p.label, env: { ...p.env } } : null
}
