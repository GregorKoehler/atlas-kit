/* ------------------------------------------------------------------ *
 * Bridge agents get prompt FILES — the port of the box's promptFileLaunch to
 * `agent-bridge/server.mjs`, plus the capability negotiation that makes it safe
 * on a fleet where each bridge machine is redeployed separately.
 *
 * Why each part is pinned:
 *
 *  1. THE SHELL SHAPE is shared (api/src/prompt-file-launch.mjs) instead of
 *     copied, and it is asserted by RUNNING it: a 30 KB prompt full of `$&`,
 *     `$'`, backticks and quotes must come back byte-identical, the file must be
 *     gone afterwards, and an unreadable file must STOP the launch rather than
 *     start an agent with an empty prompt.
 *  2. THE BRIDGE builds that same command around a file inside the container.
 *     The server binds a port and exits without a token, so it cannot be
 *     imported — same convention as agent-bridge-boundary-delivery.test.mjs: its
 *     spawn function is asserted against the SOURCE.
 *  3. THE BOX must never ASSUME the new transport. The bridge is deployed per
 *     machine, and an oversized prompt to an un-redeployed one fails every spawn
 *     against it silently. So: full bundle only when the bridge advertises
 *     `prompt-file`, and the budget-and-clip path otherwise — including when
 *     /health is unreachable or malformed (fail closed).
 *  4. THE DROPS ARE AUDITED. A `return ''` guard that only console.errors is why
 *     the box's audit log could hold no evidence line at all for a bridge spawn,
 *     making the whole question unfalsifiable from the log.
 *
 * Run: node --test api/test/bridge-prompt-file.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

const STATE_DIR = tmp('atlas-kit-promptfile-local-')
process.env.AGENT_LOCAL_DIR = STATE_DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_REPOS = path.join(tmp('atlas-kit-promptfile-repos-'), 'none.json') // every repo routes to a bridge
process.env.WORKSPACE_DIR = tmp('atlas-kit-promptfile-ws-') // not a git repo

/* --- fixture Atlas, registered as the `atlas` vault ------------------ *
 * remoteEvidence/atlasEvidence resolve the atlas root through the vault
 * registry, so the retrieval under test must be a FACT THIS TEST SETS — on a box
 * the real Atlas would answer instead. Must precede the import (vaults.mjs reads
 * VAULTS_FILE at module load). */
const ATLAS = tmp('atlas-kit-promptfile-atlas-')
const write = (rel, body) => {
  const abs = path.join(ATLAS, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}
// One distinctive term per page (IDF discounts a term that appears everywhere, so
// 100 identical pages retrieve nothing), each page long enough to be excerpted in
// full — that is what puts the bundle past the bridge's tmux ceiling, which is the
// whole point of the port. Apostrophe-dense on purpose: the budget buys CHARACTERS
// and tmux measures BYTES after `'` → `'\''`, and that gap is what the second
// guard below exists to catch.
const TOKENS = ['zephyrine', 'quorbital', 'manticorp', 'velodrax', 'pinnasketch', 'trombular', 'glaivewise', 'umberflux', 'castorine', 'nimbelith', 'ferrothane', 'oxalgrid', 'sundermill', 'brackwater']
const q = "'".repeat(6)
const para = (tok, n) =>
  `The ${tok} path ${q} matters here: the operator's card's own ${tok} rendering ${q} of contextTokens ${q} is what the agent's card shows, and it doesn't ${q} change when the field's value ${q} does. `.repeat(n)
write('Wiki/index.md', Array.from({ length: 30 }, (_, i) => `- [[Widget-Note-${i}]] — the agent's card's contextTokens ${q} field's ${TOKENS[i % TOKENS.length]} notes ${q}`).join('\n'))
write('Wiki/Projects/Widget-Dashboard.md', `---\ntype: project\nagent_repo: widget\n---\n\n# Widget Dashboard\n\n${para('contextTokens', 3)}\n\n${TOKENS.map((t) => para(t, 3)).join('\n\n')}\n`)
TOKENS.forEach((tok, i) => write(`Wiki/Sources/hit-${i}.md`, `---\ntype: source\n---\n\n# ${tok} note\n\n${para(tok, 4)}\n\n${para(tok, 4)}\n\n${para(tok, 4)}\n`))
for (let i = 0; i < 60; i++) write(`Wiki/Sources/filler-${i}.md`, `---\ntype: source\n---\n\n# Filler ${i}\n\nUnrelated prose about pipelines and storage.\n`)
const REGISTRY = path.join(tmp('atlas-kit-promptfile-reg-'), 'vaults.json')
fs.writeFileSync(REGISTRY, JSON.stringify({ atlas: { path: ATLAS, label: 'Atlas' } }))
process.env.VAULTS_FILE = REGISTRY

// A successful spawn fires generateTitle(), a fire-and-forget `claude -p` child.
// An empty PATH plus an unresolvable CLAUDE_BIN makes it refuse immediately
// (which generateTitle already handles) instead of holding the test process open
// on a real model call. Both are needed: the resolver (src/claude-bin.mjs) falls
// back to ~/.local/bin and /usr/local/bin when PATH misses, and CLAUDE_BIN is the
// authoritative override that shuts that door. Everything this file runs itself
// uses an absolute interpreter path.
process.env.PATH = tmp('atlas-kit-promptfile-nopath-')
process.env.CLAUDE_BIN = path.join(tmp('atlas-kit-promptfile-noclaude-'), 'claude')

const { agentRouter, remoteEvidence } = await import('../src/agent-routes.mjs')
const { atlasEvidence, TMUX_MAX_COMMAND_BYTES } = await import('../src/agent-local.mjs')
const { promptFileBody, promptFileCommand } = await import('../src/prompt-file-launch.mjs')

const TASK = `Render the contextTokens field on the agent card — ${TOKENS.join(' ')}`
const REPO = 'widget'
// The shell tests below run a real /bin/sh; PATH above is deliberately empty, so
// give the child the one it needs to find `cat` and `printf`.
const SH_ENV = { ...process.env, PATH: '/usr/bin:/bin' }
const auditLines = () =>
  fs
    .readFileSync(path.join(STATE_DIR, 'audit.log'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
// What the bridge's tmux command would actually measure: shquote rewrites each
// `'` as `'\''`. Same formula the sizing in agent-routes.mjs uses.
const quoted = (s) => Buffer.byteLength(s) + 3 * (s.match(/'/g)?.length || 0)

/* --- 1. the shared shape, executed by a real shell -------------------- */

const NASTY =
  `A prompt with $& and $' — String.replace's replacement patterns mangled exactly these.\n` +
  'Backticks `date`, "double quotes", \'single quotes\', a \\ backslash, ünïcode ⚠️, $(echo no).\n'
const BIG = NASTY.repeat(200) // ~30 KB, an order of magnitude past tmux's limit

test('a 30 KB prompt round-trips byte-exactly, and the command stays tiny', () => {
  const dir = tmp('atlas-kit-promptfile-run-')
  const file = path.join(dir, 'prompt.txt')
  const out = path.join(dir, 'out.txt')
  fs.writeFileSync(file, promptFileBody(BIG))
  const cmd = promptFileCommand(`printf %s {task} > '${out}'`, file)
  execFileSync('/bin/sh', ['-lc', cmd], { env: SH_ENV })
  assert.equal(fs.readFileSync(out, 'utf-8'), promptFileBody(BIG))
  assert.ok(Buffer.byteLength(BIG) > 30000, 'the fixture prompt must be past the ceiling to prove anything')
  assert.ok(
    Buffer.byteLength(cmd) < 1000,
    `the launch command must be O(path), not O(prompt) — it was ${Buffer.byteLength(cmd)} B`,
  )
  assert.equal(fs.existsSync(file), false, 'the file must be removed by the launch, right after the read')
})

test('trailing newlines are stripped on the way to disk, because $(cat) strips them coming back', () => {
  assert.equal(promptFileBody('one line\n\n\n'), 'one line')
  assert.equal(promptFileBody('inner\n\nblank lines kept\n'), 'inner\n\nblank lines kept')
  const dir = tmp('atlas-kit-promptfile-nl-')
  const file = path.join(dir, 'prompt.txt')
  const out = path.join(dir, 'out.txt')
  fs.writeFileSync(file, promptFileBody('trailing\n\n'))
  execFileSync('/bin/sh', ['-lc', promptFileCommand(`printf %s {task} > '${out}'`, file)], { env: SH_ENV })
  assert.equal(fs.readFileSync(out, 'utf-8'), 'trailing')
})

test('an unreadable prompt file STOPS the launch — `&&`, never `;`', () => {
  const dir = tmp('atlas-kit-promptfile-missing-')
  const marker = path.join(dir, 'ran')
  const cmd = promptFileCommand(`touch '${marker}' && : {task}`, path.join(dir, 'gone.txt'))
  assert.throws(() => execFileSync('/bin/sh', ['-lc', cmd], { stdio: 'ignore', env: SH_ENV }), 'the launch must exit non-zero')
  assert.equal(fs.existsSync(marker), false, 'an agent must never start with an empty prompt')
})

/* --- 2. the bridge builds that same command -------------------------- */

const src = fs.readFileSync(new URL('../../agent-bridge/server.mjs', import.meta.url), 'utf-8')
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const spawnFn = (() => {
  const start = src.indexOf('async function spawn({')
  assert.ok(start > 0, 'spawn() not found in agent-bridge/server.mjs')
  const end = src.indexOf('\n// Shared front half of prompt/interrupt/queue', start)
  assert.ok(end > start, 'end of spawn() not found')
  return src.slice(start, end)
})()

test('the bridge writes the prompt into the container and launches from the FILE', () => {
  assert.match(src, /import \{ promptFileBody, promptFileCommand \} from '\.\.\/api\/src\/prompt-file-launch\.mjs'/, 'one shape, not a copy')
  assert.match(spawnFn, /dockerExecInput\(container, \['sh', '-c', `cat > \$\{shquote\(promptPath\)\}`\], Buffer\.from\(promptFileBody\(prompt\)\)\)/)
  assert.match(spawnFn, /promptFileCommand\(\s*msgEnv\(session\) \+\s*LAUNCH_CMD/)
  assert.doesNotMatch(code(spawnFn), /\.replace\('\{task\}'/, 'the prompt must never be interpolated into the tmux command again')
})

test('the prompt file is per-session, under /tmp, outside every repo and worktree', () => {
  assert.match(src, /const PROMPT_DIR = process\.env\.BRIDGE_PROMPT_DIR \|\| '\/tmp\/atlas-kit-prompts'/)
  assert.match(src, /const promptFileFor = \(id\) => path\.posix\.join\(PROMPT_DIR, .*id.*\)/)
  assert.match(spawnFn, /const promptPath = promptFileFor\(id\)/)
  assert.doesNotMatch(code(spawnFn), /promptFileFor\(.*worktree/)
})

test('a failed write fails the SPAWN — an unbriefed agent is the bug, not the fallback', () => {
  const guard = spawnFn.indexOf('if (!pw.ok)')
  const launch = spawnFn.indexOf("'tmux', 'new-session'")
  assert.ok(guard > 0 && launch > guard, 'the write must be checked before the session is created')
  assert.match(spawnFn.slice(guard, launch), /status: 502, ok: false/)
  // A launch that never ran never removed the file either.
  assert.match(spawnFn, /await dockerExec\(container, \['rm', '-f', promptPath\]\)/)
})

test('the bridge ADVERTISES the transport on /health — that is what the box negotiates on', () => {
  assert.match(src, /const FEATURES = \['prompt-file'\]/)
  assert.match(src, /p === '\/health'\) \{[\s\S]{0,1400}?return send\(res, 200, \{ ok: true, service: 'agent-bridge', sha: startupSha, features: FEATURES/)
})

/* --- 3. the box negotiates, per bridge, fail-closed ------------------- */

const FAKE_TOKEN = 'test-bridge-token'
let fakeBridge, fakeUrl
let health = { status: 200, body: { ok: true, service: 'agent-bridge', features: ['prompt-file'] } }
let lastSpawn = null

before(async () => {
  fakeBridge = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET' && req.url === '/health') return json(health.status, health.body)
      if ((req.headers['authorization'] || '') !== `Bearer ${FAKE_TOKEN}`) return json(401, { ok: false, error: 'unauthorized' })
      if (req.method === 'POST' && req.url === '/spawn') {
        let raw = ''
        req.on('data', (d) => (raw += d))
        return req.on('end', () => {
          lastSpawn = JSON.parse(raw)
          json(200, { ok: true, id: 'widget-agent' })
        })
      }
      json(404, { ok: false, error: 'not found' })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  fakeUrl = `http://127.0.0.1:${fakeBridge.address().port}`
  process.env.AGENT_BRIDGE_URL = fakeUrl
  process.env.AGENT_BRIDGE_TOKEN = FAKE_TOKEN
})

after(() => fakeBridge.close())

async function spawnViaRoute() {
  lastSpawn = null
  const app = express()
  app.use(agentRouter((_req, _res, next) => next()))
  const server = app.listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: TASK, repo: REPO }),
    })
    return { status: res.status, body: await res.json(), sent: lastSpawn }
  } finally {
    server.close()
  }
}

test('a bridge that advertises prompt-file gets the FULL bundle, past the old ceiling', async () => {
  health = { status: 200, body: { ok: true, features: ['prompt-file'] } }
  const r = await spawnViaRoute()
  assert.equal(r.status, 200)
  assert.match(r.sent.preamble, /# Atlas evidence \(retrieved/)
  assert.match(r.sent.preamble, /hit-\d+\.md/, 'retrieved pages, not just the framing')
  assert.ok(
    quoted(r.sent.preamble) > TMUX_MAX_COMMAND_BYTES,
    `the point of the port: this prompt (${quoted(r.sent.preamble)} B quoted) could never have gone through tmux`,
  )
  const line = auditLines().findLast((l) => l.action === 'spawn' && l.remote)
  assert.ok(line && line.ok && line.promptFile === true && line.evidence > 0, 'the remote spawn must be audited like a local one')
  assert.equal(line.repo, REPO)
})

/* An un-upgraded bridge must keep spawning — just without the bigger bundle.
 * "Keeps working" is measured the only way that matters here: what the box sent
 * would still have fit in that bridge's tmux command. */
const fitsLegacyTmux = (sent) =>
  quoted(`${sent.preamble}\n\n---\n# Your task\n${sent.task}`) + Number(process.env.AGENT_BRIDGE_LAUNCH_RESERVE || 1500) <=
  TMUX_MAX_COMMAND_BYTES

test('a bridge with no features (never redeployed) still spawns, clipped to its tmux command', async () => {
  health = { status: 200, body: { ok: true, service: 'agent-bridge' } } // pre-port /health
  const r = await spawnViaRoute()
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, id: 'widget-agent' })
  assert.ok(fitsLegacyTmux(r.sent), `sent ${quoted(r.sent.preamble)} B quoted — an un-upgraded bridge would reject it`)
  const line = auditLines().findLast((l) => l.action === 'spawn' && l.remote)
  assert.equal(line.promptFile, false)
})

test('an unreachable or malformed /health fails CLOSED, never open', async () => {
  for (const h of [
    { status: 500, body: { ok: false } },
    { status: 200, body: { ok: true, features: 'prompt-file' } }, // not an array
    { status: 200, body: { ok: true, features: ['something-else'] } },
  ]) {
    health = h
    const r = await spawnViaRoute()
    assert.equal(r.status, 200, `spawn must still go through for ${JSON.stringify(h.body)}`)
    assert.ok(fitsLegacyTmux(r.sent), `assumed the new transport on ${JSON.stringify(h.body)}`)
  }
})

/* --- 4. the drops are audible ---------------------------------------- */

test('an evidence-less remote spawn is never SILENT, whatever emptied it', async () => {
  // The property, across the whole range of preamble sizes: if the agent leaves
  // with no evidence, the audit log says so — either a guard line from here, or
  // atlasEvidence's own line reporting a block of 0. Before this, the no-budget
  // guard returned before atlasEvidence() was ever called, so a bridge spawn
  // produced no evidence line at all and the drop was unfalsifiable.
  const guards = new Set()
  for (let n = 2000; n <= 17000; n += 500) {
    const before = auditLines().length
    const block = await remoteEvidence({ task: TASK, repo: REPO, preamble: 'x'.repeat(n), bridge: 'fake-bridge' })
    if (block) continue
    const added = auditLines().slice(before).filter((l) => l.action === 'atlas-evidence')
    assert.ok(added.length, `the drop at a ${n} B preamble was silent — that is the whole bug`)
    const drop = added.findLast((l) => l.ok === false && l.guard)
    if (!drop) {
      assert.equal(added.at(-1).block, 0, 'an empty retrieval must still be reported as empty')
      continue
    }
    assert.equal(drop.remote, true)
    assert.equal(drop.bridge, 'fake-bridge')
    assert.equal(drop.limit, TMUX_MAX_COMMAND_BYTES)
    assert.ok(typeof drop.base === 'number' && drop.base > 0, 'the base size must be on the line')
    guards.add(drop.guard)
  }
  assert.ok(guards.has('no-budget'), `expected a no-budget drop; saw ${[...guards]}`)
})

test('the over-limit guard — the quoting-growth backstop — carries its own numbers', async () => {
  // Quote-dense evidence is what makes the byte check bite: the budget buys
  // CHARACTERS, tmux measures BYTES after `'` → `'\''`. The fixture's tail exists
  // for this case. Find the base size where it fires rather than hardcoding one.
  let drop = null
  for (let n = 2000; n <= 14000 && !drop; n += 250) {
    const before = auditLines().length
    if (await remoteEvidence({ task: TASK, repo: REPO, preamble: 'x'.repeat(n), bridge: 'fake-bridge' })) continue
    drop = auditLines()
      .slice(before)
      .findLast((l) => l.action === 'atlas-evidence' && l.ok === false && l.guard === 'over-limit')
  }
  assert.ok(drop, 'no over-limit drop reproduced')
  assert.ok(drop.budget > 0 && drop.block > drop.budget, 'the line must show the block outgrowing its budget once quoted')
  assert.equal(drop.reserve, Number(process.env.AGENT_BRIDGE_LAUNCH_RESERVE || 1500))
})

test('a full-size bundle still exists to be dropped (the fixture is not the reason)', async () => {
  const full = await atlasEvidence({ task: TASK, repo: REPO, root: ATLAS })
  assert.ok(full.length > TMUX_MAX_COMMAND_BYTES, `fixture bundle is only ${full.length} B — it cannot prove the ceiling`)
})
