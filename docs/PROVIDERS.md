# Model-provider profiles

Atlas Kit's dev agents run on the `claude` CLI against Anthropic, on your
subscription. A **provider profile** points that same CLI at a **different,
Anthropic-compatible backend** — DeepSeek through OpenRouter, DeepSeek direct,
anything that speaks the Anthropic Messages API — for one spawn, chosen from the
dashboard's spawn form.

Nothing else about the agent changes. Same tmux session, same `ATLAS:` ship
markers, same lifecycle machine, same MCP read tools, same prompt-file evidence
bundle, same Kanban and commit queue. **The harness is Claude-Code-shaped and
stays that way** — this is not a second agent CLI (no opencode, no aider), it is
the one you already run, with a different base URL in its environment.

> 🔴 **Zero profiles must be zero cost.** With no `providers.json` and no
> `provider` on a spawn, the launch line is byte-identical to a kit that never
> had this feature, `GET /api/providers` is empty, and the spawn form shows no
> picker. Same invariant, and same reason, as [zero addons](ADDONS.md).

---

## The profile store

Copy the template and edit it:

```bash
cp api/src/providers.example.json api/src/providers.json
```

`api/src/providers.json` is **gitignored** — it holds your API keys. Set
`ATLAS_PROVIDERS_FILE=/path/to/providers.json` to keep it somewhere else
entirely. It is re-read per call, so editing a profile needs no restart (a
running agent keeps the environment it launched with, though — see
[Resuming](#resuming-a-profiled-agent)).

```json
{
  "deepseek-openrouter": {
    "label": "DeepSeek (OpenRouter)",
    "env": {
      "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
      "ANTHROPIC_AUTH_TOKEN": "sk-or-v1-…",
      "ANTHROPIC_API_KEY": "",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek/deepseek-v4-pro",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek/deepseek-v4-flash",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-v4-flash",
      "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek/deepseek-v4-flash"
    }
  }
}
```

The key is the profile **name** (lowercase, digits, dashes) that the spawn form,
`POST /api/agents/spawn` and the MCP `spawn_agent` tool accept as `provider`.
`label` is what the dropdown shows.

**`env` is opaque.** Atlas Kit hardcodes no provider list and knows none of these
variable names — it reads the block and injects it verbatim. A backend the kit
has never heard of works the moment you can describe it as environment
variables. That is deliberately the same open-world shape addons have.

A malformed profile is **dropped, not fatal**: a name that is not
`[a-z0-9][a-z0-9-]*`, an env name that is not a shell identifier, a value that
is not a string or that contains a newline or a NUL (a newline in a credential is
a mis-pasted key every time — better caught here than as a confusing auth error
at the agent's first turn).

## The two profiles that ship

`providers.example.json` ships both, with placeholder keys.

### `deepseek-openrouter` — DeepSeek sourced through OpenRouter

OpenRouter exposes an **Anthropic-native endpoint** ("the Anthropic skin")
alongside its OpenAI-shaped one:

| variable | value | why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` | **no `/v1` suffix** — Claude Code appends `/v1/messages` itself |
| `ANTHROPIC_AUTH_TOKEN` | your OpenRouter key | sent as the bearer |
| `ANTHROPIC_API_KEY` | `""` | must be **explicitly empty, not unset**, or Claude Code can fall back to first-party Anthropic auth |
| `ANTHROPIC_DEFAULT_*_MODEL` | OpenRouter slugs | the tier mapping, below |

Slugs verified against `GET https://openrouter.ai/api/v1/models` (no key needed)
on 2026-08-15: `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` both
resolve, both at a 1M context window; dated pins
(`deepseek/deepseek-v4-pro-0813`) exist beside them. **Re-check that endpoint
rather than trusting this table** — slugs move, and a stale one fails at the
agent's first turn.

### `deepseek-direct` — DeepSeek's own API

DeepSeek's platform speaks the Anthropic format directly, so no gateway is
involved: `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, your DeepSeek
key in `ANTHROPIC_AUTH_TOKEN`, and their own model names
(`deepseek-v4-pro` / `deepseek-v4-flash`) in the tier variables, per their
Anthropic-compatibility docs. Fewer moving parts than the gateway; no
cross-provider fallback either.

## Tier mapping — how the model picker still works

The spawn form's model dropdown picks a **tier**, not a model — that is all it
ever meant. Without a profile the kit resolves the tier to Anthropic's model ID
(`sonnet` → `claude-sonnet-5[1m]`) and passes that to `claude --model`.

**With a profile, the tier alias itself is passed instead**, and the profile's
`ANTHROPIC_DEFAULT_<TIER>_MODEL` is what maps it to the backend's model:

```
dropdown "Opus"  →  --model opus  →  ANTHROPIC_DEFAULT_OPUS_MODEL   →  deepseek/deepseek-v4-pro
dropdown "Sonnet" → --model sonnet → ANTHROPIC_DEFAULT_SONNET_MODEL →  deepseek/deepseek-v4-flash
```

This matters more than it looks: hand Claude Code the resolved
`claude-sonnet-5[1m]` and it sends **that** model name to the gateway — i.e.
asks your DeepSeek profile for Anthropic's own Sonnet, which OpenRouter will
happily serve and bill. The kit does not let that happen.

Consequences:

- **Opus and Sonnet only.** There is no `fable` tier for Claude Code to resolve,
  so the picker hides Fable while a profile is selected and the API refuses the
  pair (`400`). Map `ANTHROPIC_DEFAULT_HAIKU_MODEL` too — Claude Code uses the
  haiku tier internally — and `CLAUDE_CODE_SUBAGENT_MODEL` for sub-agents.
- **Effort is untouched.** `--effort high/xhigh/max` is passed exactly as before;
  what a given backend does with it is that backend's business.
- Everything else on the launch line — the MCP config, `--strict-mcp-config`,
  `--dangerously-skip-permissions`, the prompt file — is character-for-character
  what a normal spawn gets.

## Spawning against a profile

**Dashboard** — a second dropdown appears beside the model picker on every spawn
form, but only on a box that has profiles configured. `Anthropic` (the default)
means no profile: exactly today's behaviour. It applies to a scheduled spawn too.

**API** —

```bash
curl -sX POST http://127.0.0.1:3001/api/agents/spawn \
  -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" -H 'content-type: application/json' \
  -d '{"task":"…","repo":"my-project","model":"opus","provider":"deepseek-openrouter"}'
```

**MCP** — `spawn_agent` takes the same optional `provider`, so an Atlas
orchestrator can put a dev agent on another backend.

`GET /api/providers` lists what is configured — **names and labels only**.

Every way a profile cannot be honoured is a **`400` with the reason**, never a
silent fallback: an unknown profile name, a knowledge chat (profiles are a
dev-agent feature — the Atlas orchestrator and the paired Atlas worker stay on
the subscription backend), an unmappable tier, or a repo that routes to the
remote agent bridge. Ignoring the field would run the agent on precisely the
backend you were moving off, and say nothing.

### Resuming a profiled agent

The profile **name** is stored on the session, so Revive relaunches it on the
same backend. If that profile is gone from `providers.json` by then, the revive
**refuses with that reason** rather than quietly resuming the conversation on
Anthropic.

## Where the key goes, and where it does not

A profile's env **travels by file**, exactly like an agent's launch prompt: the
API writes a `0600` file that the session's own shell sources and deletes before
`claude` starts. Nothing carries a value in an argv, so an API key is not in `ps`
output, not in the pane's scrollback, and not in the launch line at all.

(The obvious implementation — `tmux new-session -e NAME=value` — is not this one
for exactly that reason: it puts every value in the tmux invocation's own argv,
and the tmux *server* that a first spawn starts keeps that argv for its whole
life. `api/test/provider-profiles.test.mjs` drives a real tmux with a stub
`claude` and greps `ps` to keep that honest.)

It is also never in: `GET /api/providers` (names and labels only), the session
view the dashboard renders, `state.json` (the profile **name** is persisted, the
env is resolved per launch), or the audit journal. `api/test/provider-profiles.test.mjs`
sweeps a canary value across all of those.

What that does **not** buy you: `providers.json` is a plaintext file, the API
process holds the values in memory, and anyone who can read `/proc/<pid>/environ`
of a running agent (root, on this box) can read the key. This is the same trust
boundary the rest of the kit assumes — one operator, one box, agents running as
root. Treat the key as box-level, and prefer a **scoped, spend-capped** gateway
key over an unlimited one.

Two things to keep off the profile: put `ANTHROPIC_*` variables **only** here,
never in `~/.profile` or `/etc/profile` — agents launch through `sh -lc`, and a
login shell that exports its own would override the profile for every agent,
including the ones meant to run on Anthropic. And leave `.env`'s
`ANTHROPIC_API_KEY` blank as always; a profile sets its own explicitly-empty
value, so the subscription-auth guarantee holds for every non-profiled agent
exactly as before.

## Caveats — read these before you rely on a profile

- **OpenRouter guarantees the Anthropic skin for Anthropic's own models.** Using
  it to reach DeepSeek is off the supported path. Field reports say the core
  agentic loop — file edits, bash, tool use — works; nobody promises it will
  keep working after either side ships a change.
- **No extended thinking on DeepSeek**, whatever gateway you use.
- **No `cache_control` prompt caching on DeepSeek**, whatever gateway you use.
  This is a cost and latency change, not just a missing feature: Atlas Kit hands
  every agent a large system prompt plus a retrieved evidence bundle, and on
  Anthropic that block is cached across turns. Without the cache discount the
  per-token price is lower but the *billed* token count per turn is much higher.
  Measure before concluding it is cheaper.
- **Rate limits, tool-call fidelity and long-context behaviour are the
  backend's.** A profile changes where the tokens go, not what the model can do.
- **Box-local only.** Dev agents that route to the remote **agent bridge**
  (`agent-bridge/`) cannot take a profile yet — the spawn is refused rather than
  run on the default backend. The bridge would need its own profile store on its
  own box; forwarding resolved env values across that hop would put your API key
  on the wire, which is the wrong trade for a contained feature.

## Backends with no Anthropic-format endpoint

If a provider only speaks OpenAI's format, a **local translation proxy** in
front of it is the usual answer — `claude-code-router`, `y-router`,
`anthropic-proxy`. Run one on the box, point a profile's `ANTHROPIC_BASE_URL` at
`http://127.0.0.1:<its-port>`, and the kit needs no change: from its side that
is just another Anthropic-compatible endpoint.

Atlas Kit **does not vendor** any of them. They are a third dependency with
their own release cadence and their own security surface, and the profile
mechanism is deliberately the kind of seam you can point at whatever you choose
to run.
