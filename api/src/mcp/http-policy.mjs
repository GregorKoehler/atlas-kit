/* ------------------------------------------------------------------ *
 * The HTTP MCP server's fail-closed policy — the pure decision core of
 * http.mjs, split out so it is assertable without binding a port.
 *
 * Why this exists: the Access gate used to be `if (!CF_TEAM || !CF_AUD)
 * return next() // unconfigured → open (localhost-only anyway)`. Once you
 * follow docs/SETUP.md the endpoint is PUBLICLY ROUTED (the cloudflared
 * template in infra/cloudflared-config.example.yml sends mcp.<your-domain>
 * → http://localhost:3002), so CLEARING either CF_ACCESS_* value silently
 * republishes the whole knowledge base with no auth and no error anywhere.
 * Emptying an env value is not a code-review event, and the parenthetical
 * "localhost-only anyway" was the only thing standing behind it — enforced
 * nowhere. So the invariant is structural now: reachable WITHOUT Access
 * configured is not a warning, it is a refusal to start.
 *
 * ⚠️ And "loopback" is NOT the same as "unreachable": cloudflared dials its
 * origin over loopback, so an ingress rule for this port publishes it while
 * MCP_BIND=127.0.0.1 still looks safe. A bind-only check would therefore pass
 * on exactly the setup the docs tell you to build. accessPolicy() takes the
 * tunnel's ingress too: a routed port with the gate inactive is the SAME
 * refusal as a wide bind.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/** Read an env value treating present-but-empty (and whitespace) exactly as unset. */
export const cleanEnv = (v) => (typeof v === 'string' ? v.trim() : '')

const LOOPBACK_NAMES = new Set(['localhost', '::1', '::ffff:127.0.0.1'])

/**
 * Is this bind address loopback-only? Unset/empty → true (http.mjs defaults to
 * 127.0.0.1). Everything not provably loopback — `0.0.0.0`, `::`, a LAN/tailnet
 * address, a hostname — is treated as reachable, which is the safe direction:
 * the worst a false negative costs is a refusal to start on an exotic bind.
 */
export function isLoopbackBind(bind) {
  const b = cleanEnv(bind).toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (!b) return true
  if (LOOPBACK_NAMES.has(b)) return true
  return /^127(\.\d{1,3}){3}$/.test(b) // the whole 127/8, not just 127.0.0.1
}

/**
 * Which public hostnames a cloudflared ingress config routes to `port`. Pure: takes
 * the config TEXT. An entry counts however it names the origin (`localhost`,
 * `127.0.0.1`, the box's LAN IP) — what matters is that the port is published.
 * Unparseable/absent config → [] (see readTunnelIngress for why that is not "safe").
 */
export function tunnelHostnamesForPort(configText, port) {
  let doc
  try {
    doc = yaml.load(configText)
  } catch {
    return []
  }
  const rules = Array.isArray(doc?.ingress) ? doc.ingress : []
  const hits = []
  for (const r of rules) {
    const svc = cleanEnv(r?.service)
    if (!svc || !/^https?:\/\//i.test(svc)) continue // http_status:404, bastion, tcp://…
    let u
    try {
      u = new URL(svc)
    } catch {
      continue
    }
    const p = u.port || (u.protocol === 'https:' ? '443' : '80')
    if (Number(p) === Number(port)) hits.push(cleanEnv(r?.hostname) || '(catch-all)')
  }
  return hits
}

// cloudflared's own search order, plus a CLOUDFLARED_CONFIG override (a systemd unit
// usually passes --config explicitly) and /root/.cloudflared, since the documented
// install runs cloudflared as a root service while Express may run under another HOME.
const CONFIG_CANDIDATES = () => {
  const dirs = [process.env.HOME ? path.join(process.env.HOME, '.cloudflared') : '', '/root/.cloudflared', '/etc/cloudflared']
  const files = dirs.filter(Boolean).flatMap((d) => [path.join(d, 'config.yml'), path.join(d, 'config.yaml')])
  return [cleanEnv(process.env.CLOUDFLARED_CONFIG), ...files].filter(Boolean)
}

/**
 * Read the box's cloudflared ingress and report the hostnames routed to `port`.
 *
 * Deliberately only a POSITIVE match counts: no config file (a dev container, CI) is
 * genuinely "no local tunnel", and refusing on absence would break every non-box run.
 * The blind spot is real and worth stating: a REMOTELY managed tunnel keeps its
 * ingress in the Cloudflare dashboard, where the origin cannot see it. This check
 * catches the locally-configured tunnel docs/SETUP.md tells you to create; it does
 * not replace checking your own Access policy.
 */
export function readTunnelIngress(port) {
  for (const file of CONFIG_CANDIDATES()) {
    let text
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    return { file, hostnames: tunnelHostnamesForPort(text, port) }
  }
  return { file: '', hostnames: [] }
}

/**
 * Decide whether the server may serve at all, and whether the Access gate is live.
 *   { ok: false, message }  → refuse to start (non-zero exit); never serve unguarded.
 *   { ok: true,  enforced } → serve; `enforced` = verify every /mcp request's JWT.
 * `warnings` is never empty when the gate is inactive or the origin is reachable —
 * an inactive gate must be impossible to have SILENTLY.
 *
 * `tunnel` is what readTunnelIngress() found ({ file, hostnames }); a routed port
 * counts as reachable exactly like a wide bind, because it is.
 */
export function accessPolicy({ bind, team, aud, tunnel = { file: '', hostnames: [] } }) {
  const t = cleanEnv(team)
  const a = cleanEnv(aud)
  const configured = !!(t && a) // half-configured is UNconfigured — no partial gate
  const loopback = isLoopbackBind(bind)
  const shown = cleanEnv(bind) || '127.0.0.1'
  const routed = tunnel?.hostnames?.length ? tunnel.hostnames : []
  const reachable = !loopback || routed.length > 0

  if (!configured && reachable) {
    const why = !loopback
      ? `MCP_BIND=${shown} is reachable beyond loopback`
      : `${tunnel.file} routes ${routed.join(', ')} to this port (cloudflared dials it over loopback, ` +
        `so a 127.0.0.1 bind does NOT make it unreachable)`
    return {
      ok: false,
      enforced: false,
      loopback,
      routed,
      warnings: [],
      message:
        `[atlas-kit-mcp] REFUSING TO START: ${why}, but Cloudflare Access is not configured ` +
        `(CF_ACCESS_TEAM_DOMAIN=${t ? 'set' : 'empty/unset'}, CF_ACCESS_AUD=${a ? 'set' : 'empty/unset'} ` +
        `— present-but-empty counts as unset).\n` +
        `[atlas-kit-mcp] The origin would then verify NOTHING: every /mcp caller gets the vault + Atlas read ` +
        `tools, and whether anyone is stopped depends entirely on an edge policy this process cannot see.\n` +
        `[atlas-kit-mcp] Fix ONE of: (a) set both CF_ACCESS_* in .env from the Access application fronting ` +
        `that hostname (team domain + AUD tag) and restart, or (b) remove the tunnel ingress rule for this ` +
        `port / put MCP_BIND back to 127.0.0.1 — the local stdio MCP server (server.mjs) is unaffected either way.`,
    }
  }

  const warnings = []
  if (!configured) {
    warnings.push(
      `Cloudflare Access JWT verification is INACTIVE (CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD ` +
        `${t || a ? 'only half-set' : 'empty or unset'}), so /mcp is UNAUTHENTICATED. That is only safe ` +
        `because MCP_BIND=${shown} is loopback and no local tunnel ingress routes this port. Do NOT add ` +
        `an ingress rule or open a firewall to it until Access is configured — the server will refuse to ` +
        `start if you do.`,
    )
  }
  if (reachable) {
    warnings.push(
      `this origin is reachable from outside loopback (${
        !loopback ? `MCP_BIND=${shown}` : `tunnel ingress: ${routed.join(', ')}`
      }). A verified Access JWT is necessary but NOT sufficient: it proves a request came THROUGH Access, ` +
        `not that every request must. Keep cloudflared the only ingress (no published port, firewall closed) ` +
        `and the Access policy free of Bypass/public rules.`,
    )
  }
  return { ok: true, enforced: configured, loopback, routed, warnings, message: '' }
}

/**
 * Which tool surface this endpoint serves. Narrow by DEFAULT — the 7 knowledge READ
 * tools (KNOWLEDGE_TOOLS in tools.mjs) and nothing else. Broad is opt-in via an exact
 * `ATLAS_MCP_HTTP_SURFACE=broad`; any other value, including a typo, stays narrow.
 *
 * NOTE: `broad` can never reach the AGENT-CONTROL tools (spawn/prompt/kill). http.mjs
 * passes `agentControl: false` unconditionally, so this knob only ever widens the
 * KNOWLEDGE/vault surface — steering the operator's agents is not something a remote
 * connector gets, whatever the env says.
 */
export function toolSurface(env = process.env) {
  return cleanEnv(env.ATLAS_MCP_HTTP_SURFACE).toLowerCase() === 'broad' ? 'broad' : 'knowledge'
}

/**
 * Who a VERIFIED Access JWT belongs to. A browser/IdP token carries `email`; a
 * SERVICE-TOKEN token carries `common_name: "<client-id>.access"` with `sub: ""`
 * and no `email` at all — so a bare `req.accessEmail = payload.email` leaves a
 * machine caller with an undefined identity. Null means the token verified but
 * names nobody, which we reject rather than treat as anonymous-but-allowed.
 */
export function accessPrincipal(payload) {
  const email = cleanEnv(payload?.email)
  if (email) return { kind: 'user', id: email, email }
  const cn = cleanEnv(payload?.common_name)
  if (cn) return { kind: 'service', id: `service:${cn}`, email: undefined }
  return null
}
