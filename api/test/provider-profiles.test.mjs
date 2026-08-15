/* ------------------------------------------------------------------ *
 * MODEL-PROVIDER PROFILES — running the unchanged Claude-Code harness against an
 * Anthropic-compatible third-party backend (docs/PROVIDERS.md).
 *
 * Four things must hold, and none of them is visible in a diff once these files
 * drift apart:
 *
 *   1. ZERO-PROFILE INVARIANT. With no providers.json and no `provider` on the
 *      spawn, the launch line is BYTE-IDENTICAL to what it was before profiles
 *      existed — the `{claudeEnv}` slot resolves to the exact `-u
 *      ANTHROPIC_API_KEY ` literal the templates used to hardcode. This is the
 *      same property the zero-addons invariant has, and it is asserted against a
 *      spelled-out expected string rather than against the implementation.
 *   2. SECRETS STAY SERVER-SIDE. A profile's env values reach the agent's tmux
 *      session environment and NOTHING else: not `GET /api/providers`, not the
 *      session view the dashboard renders, not the audit journal, not the
 *      command line (where `ps` would show them). Asserted with a canary value
 *      swept across every one of those surfaces.
 *   3. TIER MAPPING. The opus/sonnet picker keeps working: with a profile the
 *      TIER ALIAS is what `--model` gets, so the profile's
 *      ANTHROPIC_DEFAULT_<TIER>_MODEL is what resolves it. Handing Claude Code
 *      the resolved `claude-sonnet-5[1m]` instead would ask the gateway for
 *      Anthropic's own Sonnet — served, and billed, as if nothing were wrong.
 *   4. REFUSAL, NOT SILENT FALLBACK. Every combination the kit cannot honour
 *      (unknown profile, knowledge chat, unmappable tier, a bridge repo) is a
 *      400 — because ignoring `provider` runs the agent on exactly the backend
 *      the operator was moving off, and says nothing.
 *
 * Hermetic: ATLAS_PROVIDERS_FILE points at a temp profiles file, AGENT_LOCAL_DIR
 * / WORKSPACE_DIR at throwaway dirs, AGENT_LOCAL_RECONCILE=0 keeps the boot
 * reconciler off tmux and git. No tmux is driven, no `claude` is run, no network.
 *
 * Run: node --test api/test/provider-profiles.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-providers-'))
const PROFILES_FILE = path.join(TMP, 'providers.json')

// The value that must never surface anywhere but the tmux env.
const CANARY = 'sk-canary-MUST-NOT-LEAK-0123456789'

fs.writeFileSync(
  PROFILES_FILE,
  JSON.stringify({
    _comment: 'the example files carry one of these; it is not a profile',
    'deepseek-openrouter': {
      label: 'DeepSeek (OpenRouter)',
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: CANARY,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek/deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek/deepseek-v4-flash',
      },
    },
    'no-key-profile': { label: 'Backend that never mentions the key', env: { ANTHROPIC_BASE_URL: 'https://example.invalid/api' } },
    'quoting-torture': { label: 'Everything the shell would otherwise eat', env: { WEIRD: 'it\'s $HOME `and` "more"' } },
    'Bad Name': { label: 'invalid name', env: { A: 'b' } },
    'bad-env-name': { label: 'invalid env key', env: { 'not a var': 'b' } },
    'bad-env-value': { label: 'a newline in a credential is a mis-paste', env: { A: 'line\nbreak' } },
    'no-env': { label: 'no env block at all' },
  }),
)
process.env.ATLAS_PROVIDERS_FILE = PROFILES_FILE
process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-providers-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-providers-ws-')) // not a git repo

// A stub `claude` that records exactly what it was handed. Written (and pinned
// via CLAUDE_BIN) BEFORE agent-local.mjs is imported, because the launch
// templates bake in the resolved binary at module load.
//
// It writes to a scratch path and RENAMES it into place, so the reader below
// cannot observe a half-written file: a `> file` redirect creates the file
// before a single byte of content lands, and polling for existence caught it
// mid-write on a slow runner (green locally, red on CI — this comment is the
// scar). rename(2) within one directory is atomic, so existence now implies
// completeness.
const STUB_OUT = path.join(TMP, 'stub-claude.out')
const STUB = path.join(TMP, 'claude')
fs.writeFileSync(
  STUB,
  `#!/bin/sh\n{ printf 'argv:%s\\n' "$*"; env | grep '^ANTHROPIC' | sort; printf 'KEY=%s\\n' "\${ANTHROPIC_API_KEY-UNSET}"; } > ${STUB_OUT}.part\nmv ${STUB_OUT}.part ${STUB_OUT}\nsleep 5\n`,
  { mode: 0o755 },
)
process.env.CLAUDE_BIN = STUB

const { listProviders, resolveProvider } = await import('../src/providers.mjs')
const { LAUNCH_CMD, RESUME_CMD, launchCommand, providerLaunch, providerEnvPrefix } = await import('../src/agent-local.mjs')
const { spawnPicks } = await import('../src/agent-routes.mjs')
const { spawnBody } = await import('../src/mcp/tools.mjs')

const CTX = /^(0|false|no|off)$/i.test(process.env.AGENT_EXTENDED_CONTEXT || '') ? '' : '[1m]'

/* --- the store ------------------------------------------------------------ */

test('only well-formed profiles load — a malformed one is dropped, never thrown', () => {
  assert.deepEqual(listProviders(), [
    { name: 'deepseek-openrouter', label: 'DeepSeek (OpenRouter)' },
    { name: 'no-key-profile', label: 'Backend that never mentions the key' },
    { name: 'quoting-torture', label: 'Everything the shell would otherwise eat' },
  ])
  // Each rejected entry, and why it must be rejected rather than half-applied.
  assert.equal(resolveProvider('Bad Name'), null) // reaches a path/audit line
  assert.equal(resolveProvider('bad-env-name'), null) // not a shell/tmux env name
  assert.equal(resolveProvider('bad-env-value'), null) // a newline in a credential is a mis-paste
  assert.equal(resolveProvider('no-env'), null) // nothing to inject
  assert.equal(resolveProvider('_comment'), null) // the example files' comment key
  assert.equal(resolveProvider(undefined), null)
})

test('a missing profiles file is the DEFAULT, not an error', async () => {
  const before = process.env.ATLAS_PROVIDERS_FILE
  process.env.ATLAS_PROVIDERS_FILE = path.join(TMP, 'does-not-exist.json')
  try {
    // Re-imported through a query string so the module re-reads the env var.
    const fresh = await import(`../src/providers.mjs?nofile=${Date.now()}`)
    assert.deepEqual(fresh.listProviders(), [])
    assert.equal(fresh.resolveProvider('deepseek-openrouter'), null)
  } finally {
    process.env.ATLAS_PROVIDERS_FILE = before
  }
})

/* --- 1. the zero-profile invariant ---------------------------------------- */

test('ZERO-PROFILE INVARIANT: no provider ⇒ the launch line is what it always was', () => {
  const { exports, claudeEnv } = providerLaunch(undefined)
  assert.equal(exports, '') // nothing to write, so no env file exists at all
  assert.equal(claudeEnv, '-u ANTHROPIC_API_KEY ') // the literal the templates used to hardcode
  for (const [name, tmpl] of [['LAUNCH_CMD', LAUNCH_CMD], ['RESUME_CMD', RESUME_CMD]]) {
    const line = launchCommand(tmpl, { model: 'claude-sonnet-5[1m]', effort: 'xhigh', sid: 'abc' })
    // …then the claude binary (an absolute shell-quoted path, or the bare word
    // when it did not resolve — CI runners have no `claude` installed).
    assert.match(line, /^IS_SANDBOX=1 env -u ANTHROPIC_API_KEY \S+ --model /, `${name} lost the subscription-auth guarantee`)
    assert.match(line, /--model 'claude-sonnet-5\[1m\]' --effort 'xhigh'/, name)
  }
})

test('no launch template can leave a placeholder unfilled', () => {
  // An unfilled `{claudeEnv}` would make `env` try to run a file by that name;
  // an unfilled `{model}` would be passed to claude verbatim. `{task}` is the
  // one deliberate survivor — promptFileCommand fills it from a FILE.
  for (const tmpl of [LAUNCH_CMD, RESUME_CMD]) {
    for (const provider of [undefined, 'deepseek-openrouter']) {
      const line = launchCommand(tmpl, { model: 'm', effort: 'e', sid: 's', provider })
      assert.doesNotMatch(line, /\{(claudeEnv|model|effort|sid|atlasSession)\}/)
    }
  }
})

/* --- 2. secrets stay server-side ------------------------------------------ */

test('a profile travels BY FILE — its values never reach a command line', () => {
  const { exports, claudeEnv } = providerLaunch('deepseek-openrouter')
  // The env file's whole content: shell-quoted exports, verbatim and opaque —
  // the kit knows none of these names, it only forwards them.
  assert.equal(
    exports,
    "export ANTHROPIC_API_KEY=''\n" +
      "export ANTHROPIC_BASE_URL='https://openrouter.ai/api'\n" +
      `export ANTHROPIC_AUTH_TOKEN='${CANARY}'\n` +
      "export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek/deepseek-v4-pro'\n" +
      "export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek/deepseek-v4-flash'\n",
  )
  // …and the command line carries none of it. An argv is world-readable in `ps`,
  // which is exactly why `tmux new-session -e NAME=value` is NOT how this works.
  assert.equal(claudeEnv, '')
  const line = launchCommand(LAUNCH_CMD, { model: 'sonnet', effort: 'xhigh', provider: 'deepseek-openrouter' })
  assert.ok(!line.includes(CANARY), 'the API key reached the command line — visible in `ps`')
  assert.ok(!line.includes('openrouter.ai'), 'the profile env reached the command line')
})

test('a value that needs quoting survives the env file intact', () => {
  // The env block is opaque, so a value can be anything a string can be. Single
  // quotes are the one character POSIX single-quoting cannot nest.
  const { exports } = providerLaunch('quoting-torture')
  assert.equal(exports, "export ANTHROPIC_API_KEY=''\nexport WEIRD='it'\\''s $HOME `and` \"more\"'\n")
})

test('ANTHROPIC_API_KEY is EXPLICITLY EMPTY, never unset, under a profile', () => {
  // `-u ANTHROPIC_API_KEY` (the no-profile default) UNSETS it, and Claude Code
  // can then fall back to first-party auth against a third-party base URL. Under
  // a profile the slot empties and the key is set to the empty string instead —
  // including for a profile that never mentions it, so a stray key inherited
  // from the tmux server's global env still cannot reach the agent.
  for (const name of ['deepseek-openrouter', 'no-key-profile']) {
    const { exports, claudeEnv } = providerLaunch(name)
    assert.equal(claudeEnv, '', name)
    assert.match(exports, /^export ANTHROPIC_API_KEY=''\n/, `${name} left the key unset`)
  }
  // A profile that DOES set its own key keeps it — the env block is opaque.
  assert.equal(resolveProvider('deepseek-openrouter').env.ANTHROPIC_API_KEY, '')
})

test('END TO END, through a real tmux: the backend env arrives, and appears in no argv', async () => {
  // The one assertion that cannot be made about strings alone — and the reason
  // this is not the obvious `tmux new-session -e NAME=value` implementation:
  // that puts every value in the tmux invocation's own argv, which `ps` shows to
  // every user on the box, and which the tmux SERVER a first spawn starts then
  // keeps for its whole life.
  const socket = `atlas-kit-prov-test-${process.pid}`
  const tmux = (...args) => run('tmux', ['-L', socket, ...args])
  const prefix = providerEnvPrefix('e2e', 'deepseek-openrouter')
  const envFile = prefix.match(/^\. '([^']+)'/)?.[1]
  assert.ok(envFile && fs.existsSync(envFile), 'no env file was written')
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, 'the env file must be operator-only')

  const launch = `${prefix}${launchCommand(LAUNCH_CMD, { model: 'sonnet', effort: 'xhigh', provider: 'deepseek-openrouter' })}`
    .replace('{task}', "'hello'")
  try {
    await tmux('new-session', '-d', '-s', 'e2e', '-c', TMP, 'sh', '-lc', launch)
    // Generous: a cold CI runner pays for tmux plus a login shell before the
    // stub runs at all. A timeout fails with WHY, not with an ENOENT from read.
    for (let i = 0; i < 100 && !fs.existsSync(STUB_OUT); i++) await new Promise((r) => setTimeout(r, 100))
    assert.ok(fs.existsSync(STUB_OUT), 'the stub `claude` never ran — the launch chain broke before it')
    const saw = fs.readFileSync(STUB_OUT, 'utf-8')
    // The profile's env reached `claude` intact, through the `sh -lc` LOGIN
    // shell (which rebuilds the environment — this is what proves it survives).
    assert.match(saw, new RegExp(`^ANTHROPIC_AUTH_TOKEN=${CANARY}$`, 'm'))
    assert.match(saw, /^ANTHROPIC_BASE_URL=https:\/\/openrouter\.ai\/api$/m)
    assert.match(saw, /^ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek\/deepseek-v4-flash$/m)
    assert.match(saw, /^KEY=$/m) // set, and EMPTY — not `KEY=UNSET`
    assert.match(saw, /^argv:--model sonnet --effort xhigh /m) // the TIER, for the profile to map
    // Nothing on the box can read the key out of a process listing.
    const ps = (await run('ps', ['-eo', 'args'])).stdout
    assert.ok(!ps.includes(CANARY), 'the API key is visible in `ps` output')
    // The shell consumed and deleted the env file before claude started.
    assert.ok(!fs.existsSync(envFile), 'the env file outlived the launch')
  } finally {
    await tmux('kill-server').catch(() => {})
  }
})

test('GET /api/providers cannot serve a profile env — the list shape has no room for one', () => {
  const serialized = JSON.stringify({ providers: listProviders() })
  assert.ok(!serialized.includes(CANARY), 'the dropdown source leaked the API key')
  assert.ok(!serialized.includes('openrouter.ai'), 'the dropdown source leaked the endpoint')
  for (const p of listProviders()) assert.deepEqual(Object.keys(p).sort(), ['label', 'name'])
})

test('the session record + audit line carry the profile NAME only', async () => {
  const local = await import('../src/agent-local.mjs')
  // An unknown repo stops the spawn before any git/tmux work, which is all this
  // needs: it is the ARGUMENT handling that must never widen to the env.
  const r = await local.spawn({ task: 'canary sweep', repo: 'no-such-repo', provider: 'deepseek-openrouter' })
  assert.equal(r.ok, false)
  const sessions = JSON.stringify(await local.listSessions())
  assert.ok(!sessions.includes(CANARY))
  const auditLog = path.join(process.env.AGENT_LOCAL_DIR, 'audit.log')
  if (fs.existsSync(auditLog)) assert.ok(!fs.readFileSync(auditLog, 'utf-8').includes(CANARY))
})

/* --- 3. the model-alias interplay ----------------------------------------- */

test('the opus/sonnet picker is unchanged — with a profile it names the TIER', () => {
  // Without a profile: the resolved Anthropic model ID, exactly as before.
  assert.deepEqual(spawnPicks({ model: 'sonnet' }), { modelId: `claude-sonnet-5${CTX}`, effortLevel: 'xhigh' })
  assert.deepEqual(spawnPicks({ model: 'opus', effort: 'high' }), { modelId: `claude-opus-5${CTX}`, effortLevel: 'high' })
  // With one: the tier alias, which is what ANTHROPIC_DEFAULT_<TIER>_MODEL maps.
  const p = 'deepseek-openrouter'
  assert.deepEqual(spawnPicks({ model: 'sonnet', provider: p }), { modelId: 'sonnet', effortLevel: 'xhigh' })
  assert.deepEqual(spawnPicks({ model: 'opus', effort: 'max', provider: p }), { modelId: 'opus', effortLevel: 'max' })
  // The DEFAULT pick still applies, and still lands on a mappable tier.
  assert.equal(spawnPicks({ provider: p }).modelId, 'sonnet')
  // …and the profile is what turns that tier into a real model.
  const env = resolveProvider(p).env
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek/deepseek-v4-flash')
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek/deepseek-v4-pro')
  // The alias reaches the command line shell-quoted, like any other model value.
  assert.match(
    launchCommand(LAUNCH_CMD, { model: spawnPicks({ model: 'opus', provider: p }).modelId, effort: 'high', provider: p }),
    /--model 'opus' --effort 'high'/,
  )
})

test('effort, MCP config and every other launch flag survive a profile untouched', () => {
  const plain = launchCommand(LAUNCH_CMD, { model: 'sonnet', effort: 'xhigh' })
  const profiled = launchCommand(LAUNCH_CMD, { model: 'sonnet', effort: 'xhigh', provider: 'deepseek-openrouter' })
  // The ONLY difference is the env slot — same binary, same flags, same harness.
  assert.equal(profiled, plain.replace('-u ANTHROPIC_API_KEY ', ''))
  assert.match(profiled, /--strict-mcp-config --dangerously-skip-permissions \{task\}$/)
})

test('the MCP spawn_agent tool forwards a profile for dev agents only', () => {
  const dev = spawnBody({ task: 't', repo: 'demo', provider: 'deepseek-openrouter' })
  assert.equal(dev.provider, 'deepseek-openrouter')
  assert.equal(dev.model, 'opus') // the orchestrator's dev default, unchanged
  assert.equal(spawnBody({ task: 't', repo: 'demo' }).provider, undefined)
  assert.equal(spawnBody({ task: 't', kind: 'knowledge', provider: 'deepseek-openrouter' }).provider, undefined)
})

/* --- 4. refusal, not silent fallback -------------------------------------- */

test('every combination the kit cannot honour is a 400, with the reason', async () => {
  const { agentRouter } = await import('../src/agent-routes.mjs')
  const spawnRoute = findRoute(agentRouter((_r, _s, next) => next()), '/api/agents/spawn')
  const call = (body) =>
    new Promise((resolve) => {
      spawnRoute({ body, method: 'POST', headers: {} }, {
        status(code) { this._code = code; return this },
        json(payload) { resolve({ status: this._code ?? 200, body: payload }) },
      }, () => {})
    })

  const unknown = await call({ task: 't', repo: 'demo', provider: 'nope' })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /unknown "provider"/)
  assert.match(unknown.body.error, /deepseek-openrouter/) // names what IS configured

  const knowledge = await call({ task: 't', kind: 'knowledge', provider: 'deepseek-openrouter' })
  assert.equal(knowledge.status, 400)
  assert.match(knowledge.body.error, /DEV agents/)

  const fable = await call({ task: 't', repo: 'demo', model: 'fable', provider: 'deepseek-openrouter' })
  assert.equal(fable.status, 400)
  assert.match(fable.body.error, /mappable tier/)

  // `demo` is in no agent-local-repos.json here, so it routes to a bridge — the
  // executor that does not carry profiles yet. Refused rather than run remotely
  // on the default backend.
  const remote = await call({ task: 't', repo: 'demo', provider: 'deepseek-openrouter' })
  assert.equal(remote.status, 400)
  assert.match(remote.body.error, /box-local/)

  // The zero-profile path through the SAME route is untouched: no `provider`
  // means none of these checks runs at all.
  const plain = await call({ task: 't', repo: 'demo' })
  assert.notEqual(plain.status, 400)
})

/* Pull one route's handler out of an Express router without binding a port —
 * the layer stack is the only thing these assertions need. */
function findRoute(router, routePath) {
  const layer = router.stack.find((l) => l.route?.path === routePath)
  assert.ok(layer, `no route ${routePath}`)
  // The spawn route stacks body-parser + bearerAuth ahead of the handler; the
  // last one is the handler itself, and the others are stubbed by the caller.
  return layer.route.stack.at(-1).handle
}
