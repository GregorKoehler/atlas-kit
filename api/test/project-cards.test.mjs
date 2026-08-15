/* ------------------------------------------------------------------ *
 * Which vault pages become PROJECT CARDS, and how each card's delivery mode is
 * derived (read-routes.mjs listProjects → ship-prompt.mjs deliveryMode).
 *
 * MEMBERSHIP is the point. `Wiki/Projects/` is a normal Atlas folder and holds
 * more than the card set: project pages that carry no card schema yet, and
 * pages that are not projects at all (a `type: topic` hub, a stray note). A
 * card is a page with `type: project` AND a non-empty `goal:` — `goal` is what
 * the card renders and the one field only the operator writes, so it is the
 * opt-in that keeps membership deliberate. Adding or dropping a card here is a
 * failure.
 *
 * Every caller resolves a project by `agent_repo`, never by filename, so one
 * fixture page deliberately carries a filename that does not match its key.
 *
 * Hermetic: VAULT_PATH/VAULT_DIR point at a throwaway vault and VAULTS_FILE at
 * a file that does not exist, so vaults.mjs takes its single-vault fallback.
 *
 * Run: node --test api/test/project-cards.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-project-cards-'))
const page = (file, fm) => {
  const dir = path.join(vault, 'Wiki', 'Projects')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\n\n# ${path.basename(file, '.md')}\n`)
}

const GOAL = 'goal: "does a thing"'

// Cards. `website-redesign.md` is lower-case and hyphenated where its key is
// `website`: the filename is not the join key.
page(
  'website-redesign.md',
  `type: project\n${GOAL}\nagent_repo: website\ntag: website-redesign\ndeploy_manual: "the live instance is redeployed by hand, deliberately NOT per PR"`,
)
page('Payments-Service.md', `type: project\n${GOAL}\nagent_repo: payments\nself_deploy: true\nrepo: /srv/payments`)
page('Docs-Portal.md', `type: project\n${GOAL}\ntag: docs-portal`) // no agent_repo, no delivery flags
// Not cards.
page('Archive-Cleanup.md', 'type: project\nagent_repo: archive') // a project page, but no goal yet
page('Notes-Hub.md', `type: topic\n${GOAL}`) // has a goal, but is not a project
page('Stray-Note.md', GOAL) // no type at all

process.env.VAULT_DIR = vault
process.env.VAULT_PATH = vault
process.env.VAULTS_FILE = path.join(vault, 'no-vaults.json') // absent → single-vault fallback

const { listProjects } = await import('../src/read-routes.mjs')
const { deliveryMode } = await import('../src/ship-prompt.mjs')

const byRepo = (key) => listProjects().find((p) => p.agentRepo === key)

test('membership: `type: project` + a non-empty goal, nothing else', () => {
  assert.deepEqual(
    listProjects()
      .map((p) => p.name)
      .sort(),
    ['Docs-Portal', 'Payments-Service', 'website-redesign'],
  )
})

test('a project page with no goal is not a card yet', () => {
  assert.equal(byRepo('archive'), undefined)
})

test('a project resolves by agent_repo, not by filename', () => {
  assert.equal(byRepo('website').path, path.join('Wiki', 'Projects', 'website-redesign.md'))
})

test('deploy_manual → manual delivery (merging is not the delivery)', () => {
  const p = byRepo('website')
  assert.match(p.deployManual, /NOT per PR/)
  assert.equal(deliveryMode(p), 'manual')
})

test('self_deploy → self-deploy delivery', () => {
  assert.equal(deliveryMode(byRepo('payments')), 'self-deploy')
})

test('no delivery flags keeps the merge-is-delivery default', () => {
  const p = listProjects().find((x) => x.name === 'Docs-Portal')
  assert.equal(p.deployManual, '')
  assert.equal(deliveryMode(p), 'merge')
})

test("the optional card schema is read under the kit's own key names", () => {
  assert.equal(byRepo('website').tag, 'website-redesign')
  assert.equal(byRepo('payments').repo, '/srv/payments')
})
