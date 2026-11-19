/* ------------------------------------------------------------------ *
 * Claude Code's OWN cross-session messaging is closed on Atlas Kit-spawned
 * sessions.
 *
 * CC ≥ 2.1.224 gives every session `ListAgents`/`SendMessage` and a per-session
 * inbox socket, on by default, so every agent tmux session on the box is an
 * addressable peer. That is a second message channel beside the kit's bus — no lineage bound, no per-pair budget, no
 * `agent-messages.jsonl` line, no attribution header, invisible to the
 * dashboard. It is closed in the LAUNCH COMPOSITION, which is exactly where it
 * can silently stop being closed again: a template added later, an executor that
 * grows its own copy of the rule, or a kind mislabelled.
 *
 * What must hold:
 *   1. the policy differs by kind — dev refuses inbound AND loses both tools;
 *      knowledge/Atlas only refuses inbound (SendMessage is also the in-process
 *      subagent continuation channel, ListAgents the orchestrator's probe),
 *   2. EVERY box launch and resume template carries the right one — a revived
 *      agent must not come back with the channel reopened,
 *   3. the bridge runs the SHARED decision, not a copy (a box-only deploy would
 *      otherwise leave every bridge on the old policy),
 *   4. the kill-switch really is byte-identical to before this shipped.
 *
 * No tmux is driven: templates are read as strings, and the kill-switch is
 * proven by re-importing the executor in a child process with the env set.
 *
 * Run: node --test api/test/native-msg-policy.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { nativeMsgSettings, nativeMsgPolicyOn, withNativeMsgPolicy } from '../src/native-msg-policy.mjs'

const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-native-msg-'))
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-native-msg-ws-'))
process.env.AGENT_LOCAL_DIR = LOCAL_DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.WORKSPACE_DIR = WS

const local = await import('../src/agent-local.mjs')

// Every template the box launches or revives a session with, and the kind it is.
const TEMPLATES = [
  ['LAUNCH_CMD', 'dev'],
  ['RESUME_CMD', 'dev'],
  ['KNOWLEDGE_LAUNCH_CMD', 'knowledge'],
  ['ATLAS_CONTROL_LAUNCH_CMD', 'knowledge'],
  ['ATLAS_CONTROL_RESUME_CMD', 'knowledge'],
  ['ATLAS_WORKER_LAUNCH_CMD', 'knowledge'],
]

// The single `--settings '<json>'` a composed template carries, parsed.
function settingsIn(cmd) {
  const m = /--settings '([^']*)'/.exec(cmd)
  assert.ok(m, `no --settings in: ${cmd}`)
  assert.equal(cmd.split('--settings').length, 2, 'more than one --settings')
  return JSON.parse(m[1])
}

test('the policy is refuse-inbound for both kinds, tool denies for dev only', () => {
  assert.deepEqual(nativeMsgSettings('dev'), {
    crossSessionInbound: 'refuse',
    permissions: { deny: ['SendMessage', 'ListAgents'] },
  })
  // NOT denied for knowledge agents: SendMessage doubles as the in-process
  // subagent continuation channel, and an orchestrator probes with ListAgents.
  assert.deepEqual(nativeMsgSettings('knowledge'), { crossSessionInbound: 'refuse' })
  assert.equal(nativeMsgSettings('knowledge').permissions, undefined)
})

test('a mislabelled kind fails loudly at import time, never silently downgrades', () => {
  assert.throws(() => nativeMsgSettings('atlas'), /unknown kind/)
  assert.throws(() => withNativeMsgPolicy('claude -p', 'worker'), /unknown kind/)
})

for (const [name, kind] of TEMPLATES) {
  test(`${name} carries the ${kind} policy`, () => {
    const cmd = local[name]
    assert.ok(cmd, `${name} is not exported`)
    assert.deepEqual(settingsIn(cmd), nativeMsgSettings(kind))
    // The flag belongs to `claude` (bare, or the resolved path claude-bin.mjs
    // quotes), not to the `env -u …` prefix in front of it.
    assert.match(cmd, /[\s}/]claude'? --settings '/)
  })
}

test('the box dev launch and the bridge dev launch produce the SAME policy fields', () => {
  const bridge = fs.readFileSync(new URL('../../agent-bridge/server.mjs', import.meta.url), 'utf-8')
  const code = bridge.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  // The bridge imports the shared decision…
  assert.match(code, /import \{ withNativeMsgPolicy \} from '\.\.\/api\/src\/native-msg-policy\.mjs'/)
  // …applies it to its one launch template, as a DEV session…
  const start = code.indexOf('const LAUNCH_CMD =')
  assert.ok(start > 0, 'LAUNCH_CMD not found in agent-bridge/server.mjs')
  const decl = code.slice(start, code.indexOf('\nconst ', start + 1))
  assert.match(decl, /withNativeMsgPolicy\(/)
  assert.match(decl, /'dev'\)/)
  // …and never grows a copy of the rule (a copy is what drifts across a
  // box-only deploy — the whole reason this lives in api/src/).
  for (const literal of ['crossSessionInbound', 'SendMessage', 'ListAgents'])
    assert.doesNotMatch(code, new RegExp(literal), `${literal} hand-rolled in the bridge`)
  // Field-set equality: both executors' dev sessions get exactly these fields.
  assert.deepEqual(settingsIn(local.LAUNCH_CMD), nativeMsgSettings('dev'))
})

test('an operator template that already passes --settings is left alone', () => {
  const custom = "IS_SANDBOX=1 claude --settings '/etc/atlas-kit/agent.json' --model x {task}"
  assert.equal(withNativeMsgPolicy(custom, 'dev'), custom)
})

test('the flag lands right after the claude word, whatever shape that word takes', () => {
  const flag = `--settings '${JSON.stringify(nativeMsgSettings('knowledge'))}'`
  const cases = [
    ['IS_SANDBOX=1 claude --model x', `IS_SANDBOX=1 claude ${flag} --model x`],
    // the box template: a quoted absolute path glued to the {claudeEnv} slot
    ["env {claudeEnv}'/home/u/.local/bin/claude' --model x", `env {claudeEnv}'/home/u/.local/bin/claude' ${flag} --model x`],
    ["env -u K '/opt/my dir/claude' --resume s", `env -u K '/opt/my dir/claude' ${flag} --resume s`],
    ['env -u K /usr/local/bin/claude --model x', `env -u K /usr/local/bin/claude ${flag} --model x`],
    // an earlier path segment named claude-something is not the command word
    ["env '/srv/claude-code/bin/claude' -p", `env '/srv/claude-code/bin/claude' ${flag} -p`],
  ]
  for (const [cmd, want] of cases) assert.equal(withNativeMsgPolicy(cmd, 'knowledge'), want)
  // a template that never invokes claude is returned unchanged
  assert.equal(withNativeMsgPolicy('my-wrapper --model x', 'knowledge'), 'my-wrapper --model x')
})

test('ATLAS_NATIVE_MSG_POLICY=off injects nothing', () => {
  const off = { ATLAS_NATIVE_MSG_POLICY: 'off' }
  assert.equal(nativeMsgPolicyOn(off), false)
  const plain = 'IS_SANDBOX=1 claude --model {model} {task}'
  assert.equal(withNativeMsgPolicy(plain, 'dev', off), plain)
  for (const v of ['0', 'false', 'no', 'OFF']) assert.equal(nativeMsgPolicyOn({ ATLAS_NATIVE_MSG_POLICY: v }), false)
  for (const v of ['', '1', 'on']) assert.equal(nativeMsgPolicyOn({ ATLAS_NATIVE_MSG_POLICY: v }), true)
})

test('with ATLAS_NATIVE_MSG_POLICY=off, the real executor launches exactly as it did before', () => {
  // A child process, because the templates are module-level consts: this is the
  // whole point of the switch — one env var on the box or on a bridge restores
  // the pre-change launch line without a deploy.
  const out = execFileSync(
    process.execPath,
    ['-e', `const m = await import(${JSON.stringify(new URL('../src/agent-local.mjs', import.meta.url).pathname)});
      console.log(JSON.stringify(${JSON.stringify(TEMPLATES.map(([n]) => n))}.map((k) => m[k])))`],
    {
      encoding: 'utf-8',
      env: { ...process.env, ATLAS_NATIVE_MSG_POLICY: 'off' },
    },
  )
  for (const cmd of JSON.parse(out.trim().split('\n').pop())) {
    assert.doesNotMatch(cmd, /--settings/)
    assert.doesNotMatch(cmd, /crossSessionInbound/)
  }
})
