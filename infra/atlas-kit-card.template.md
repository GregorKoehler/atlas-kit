---
type: project
tags: [atlas-kit, dashboard, agents]
status: active
created: {{TODAY}}
updated: {{TODAY}}
goal: Run my own agents and knowledge base on this box — and keep the kit that runs them improving.
now: Freshly installed — dashboard up, vault wired, ready for a first agent.
agent_repo: {{AGENT_REPO}}
self_deploy: true
repo_path: {{REPO_PATH}}
github: {{GITHUB}}
---

# Atlas Kit

The runtime this dashboard is: a glass HUD over my vault, Claude Code dev and knowledge
agents in tmux, and a Kanban wired to `Tasks/`. This page IS its card on the home tab —
`type: project` plus a non-empty `goal:` is what makes any page render as one.

## How this card is wired

- **`goal:`** — mine to write, and the card's opt-in. Agents never touch it.
- **`now:`** — one line on where the project stands. A dev agent ending a run with its
  `ATLAS:NOW` signal rewrites exactly this key, through the serial vault commit queue.
- **`agent_repo:`** — the spawn key (from `api/src/agent-local-repos.json`) whose dev
  agents attach to this card. Empty or absent ⇒ a knowledge-only card, no agent surface.
- **`repo_path:`** + **`self_deploy: true`** — the checkout on this box, and the opt-in
  for the card's **Redeploy** button: fetch → fast-forward merge → install deps only if a
  lockfile moved → build → `scripts/serve.sh restart`. It refuses a dirty checkout or a
  non-fast-forward rather than force anything. See [docs/UPDATING.md](https://github.com/GregorKoehler/atlas-kit/blob/main/docs/UPDATING.md).

## Notes

Rewrite everything below the frontmatter — this page is yours now. Good things to keep
here: what you actually use the box for, decisions you don't want to re-make, and the
addons you enabled with what they cost you.
