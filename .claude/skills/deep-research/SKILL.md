---
name: deep-research
description: Deep, multi-source research that lands its findings in the Atlas, not just the chat. Use when you want a fact-checked report on a topic AND want it to compound in your vault — "research X", "deep dive on Y", "look into Z and add it to the Atlas". If the question is underspecified (no clear scope/angle), ask 1-2 clarifying questions before spending a research pass on it.
---

# Deep research → Atlas

The deliverable is not the chat message — it's the vault pages the chat message points to.
A research pass that isn't folded into the Atlas has to be redone next time the topic comes up.

1. **Scope first**: if the question is broad or ambiguous ("what should I know about X"),
   narrow it with 1-2 questions (angle, depth, decision it's feeding) before searching.
2. **Fan out**: run several independent searches/fetches covering different angles of the
   question (not five phrasings of the same query) — primary sources over aggregators where
   they exist.
3. **Verify**: cross-check load-bearing claims (numbers, dates, causal claims) against at
   least one more source before treating them as settled. Flag anything you couldn't verify
   as such, rather than smoothing over the gap.
4. **Check the Atlas first**: before writing anything new, search `Wiki/` (via
   `mcp__atlas-kit__query_vault` / `query_atlas` if available, else grep) for existing pages
   on the topic — a research pass should extend or correct what's there, not duplicate it.
5. **Land it in the Atlas** (this is the step that's easy to skip — don't):
   - Write/update a `Wiki/Sources/<slug>.md` page for the research pass itself if it's
     substantial (what was asked, what was found, citations).
   - Update or create the relevant `Wiki/Concepts/`, `Wiki/Topics/`, `Wiki/People/`,
     `Wiki/Organizations/`, or `Wiki/Projects/` pages with the synthesis, `[[wikilinked]]`
     to the source page and to each other.
   - Add typed edges where the Legend (`Wiki/Legend.md`) has a fitting key (`depends_on`,
     `for_project`, `stakeholders`, dates, …) — check it before coining a new one, and
     register any genuinely new key in the same edit.
   - Update `Wiki/index.md` (one line per new/changed page) and append a dated entry to
     `Wiki/log.md`.
   - Flag contradictions with existing Atlas claims explicitly rather than silently
     overwriting them.
6. **Answer in chat with citations**, pointing at the `[[wikilinks]]` you just wrote so the
   operator can jump straight into the vault — the chat answer is a pointer, the pages are
   the record.
