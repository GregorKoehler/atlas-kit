/* ------------------------------------------------------------------ *
 * What the spawn form's MODEL dropdown offers, given the selected provider
 * profile — the honesty half of docs/PROVIDERS.md's tier mapping.
 *
 * The picker has always chosen a TIER, not a model. Without a profile the tier
 * resolves to Anthropic's own model and "Opus / Sonnet" says everything there is
 * to say. With a profile it resolves through that profile's
 * ANTHROPIC_DEFAULT_<TIER>_MODEL instead — so a dropdown still reading "Opus /
 * Sonnet" never says what will actually run, which is exactly how an operator
 * reads a provider picker as having no effect. Here the options become
 * `Opus → deepseek/deepseek-v4-pro`, and a tier the profile does NOT map is not
 * offered at all: the spawn route refuses it (400), so offering it is worse than
 * hiding it.
 *
 * Lives in lib/ rather than inline in a card because BOTH spawn forms need the
 * same answer, and because this — which options, which labels, which fallback —
 * is the part worth testing without a DOM (modelTiers.test.mjs).
 * ------------------------------------------------------------------ */
import type { ProviderProfile } from './api'

/** A tier key → the word the form shows for it. */
const TIER_LABELS: Record<string, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

export interface ModelOption {
  value: string
  label: string
}

/**
 * The `<option>` list for `base` (a form's own tier keys, in its own order) under
 * `profile` — undefined/null meaning the default Anthropic backend.
 *
 * With a profile: `fable` always goes (Claude Code has no fable tier to resolve),
 * and when the profile declares tiers, only the ones it maps survive, each
 * labelled with the model it maps to. A profile that declares NO tiers degrades
 * to plain labels — as does one whose mapped tiers this form offers none of,
 * where hiding everything would leave an empty select and the server's 400 is the
 * better messenger.
 */
export function modelOptions(base: string[], profile?: ProviderProfile | null): ModelOption[] {
  const opt = (value: string, label?: string) => ({ value, label: label ?? TIER_LABELS[value] ?? value })
  if (!profile) return base.map((v) => opt(v))
  const offered = base.filter((v) => v !== 'fable')
  const tiers = profile.tiers ?? {}
  const mapped = offered.filter((v) => tiers[v])
  if (!mapped.length) return offered.map((v) => opt(v))
  return mapped.map((v) => opt(v, `${TIER_LABELS[v] ?? v} → ${tiers[v]}`))
}

/**
 * The model to hold after a provider change: the current pick when the new option
 * list still offers it, else the form's own default, else the first option. The
 * form must never sit on a combination the spawn route would refuse.
 */
export function keepModel(current: string, options: ModelOption[], fallback: string): string {
  const has = (v: string) => options.some((o) => o.value === v)
  return has(current) ? current : has(fallback) ? fallback : (options[0]?.value ?? current)
}

/** The model select's tooltip, for a form that spawns `subject` ("agent" / "chat")
 *  — Anthropic's 1M context is not a claim to make about someone else's backend,
 *  so under a profile it explains the mapping instead. */
export function modelTitle(profile?: ProviderProfile | null, subject = 'agent'): string {
  return profile
    ? `Tier for this ${subject} — mapped to a model by the "${profile.label}" backend (docs/PROVIDERS.md)`
    : `Model for this ${subject} (always the 1M-context variant)`
}
