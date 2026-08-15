/* ------------------------------------------------------------------ *
 * The pipeline: one URL → metadata → stills → analysis → one committed page.
 *
 *   parse+admit → yt-dlp metadata (caption) → yt-dlp stills → stage into the
 *   vault → claude -p → render → COMMIT QUEUE → ingest record
 *
 * 🔴 ONE INGEST AT A TIME, ONE POST PER CALL. The in-process flag below is the
 * whole rate story: no crawl, no bulk mode, no queue to fill. Two concurrent
 * ingests would also both hold the vault's commit queue and race the same asset
 * directory on a re-ingest, so serialising is correctness before it is courtesy.
 *
 * 🔴 EVERY EXIT IS RECORDED AND LOUD. Each failure path writes an ingest record
 * with its reason, logs it to stderr and answers with an actionable message — the
 * one thing this pipeline may never do is drop a post quietly.
 *
 * WHERE THE ASSETS GO, AND WHEN. Stills are staged at their FINAL vault path
 * before `claude -p` runs, because the model reads them off disk with cwd set to
 * the vault. That means a failure after staging leaves untracked files in a repo
 * whose other writers use `git add -A` — so every failure path removes them
 * again. Re-ingesting the same post wipes its asset directory first, so a post
 * that lost a carousel slide does not keep the orphan.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { enqueueAtlasCommit } from '../../../api/src/atlas-commit-queue.mjs'
import { resolveVault } from '../../../api/src/vaults.mjs'
import { parsePostUrl, cookieArgs, probeMetadata, fetchImages } from './ytdlp.mjs'
import { analyze } from './analyze.mjs'
import { renderPage, pagePathFor, assetsPathFor, assetName, isoFromUploadDate, slugFor } from './page.mjs'
import { appendRecord } from './records.mjs'
import { limits, vaultKey } from './config.mjs'

let running = false

const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
}

/**
 * Ingest one Instagram post or reel.
 *
 * Returns `{ ok: true, status: 200, … }` or `{ ok: false, status, error }` —
 * `status` is the HTTP status the route should answer with, so the routing rule
 * lives beside the failure that decided it: 400 refused, 409 busy, 502 the
 * outside world said no, 500 this box is misconfigured.
 */
export async function ingestInstagram({ url: raw, requestedBy = 'api' }) {
  const post = parsePostUrl(raw)
  if (!post) {
    return {
      ok: false,
      status: 400,
      error: 'not a single Instagram post URL — expected https://www.instagram.com/p|reel|tv/<code>/ (profiles, hashtags and /explore/ are refused: this addon files one post you already opened, it does not crawl)',
    }
  }
  if (running) return { ok: false, status: 409, error: 'an ingest is already running — one post at a time' }
  running = true

  const at = new Date().toISOString()
  const { url, code, kind } = post
  const pageRel = pagePathFor(code)
  const assetsRel = assetsPathFor(code)
  const warnings = []
  let tmp = ''
  let assetsAbs = ''
  let pageAbs = ''
  let cleanup = () => {} // set once staging knows what existed before this run

  const fail = (status, error) => {
    console.error(`[instagram-ingest] ${url} FAILED: ${error}`)
    appendRecord({ at, url, code, ok: false, requestedBy, error, warnings })
    return { ok: false, status, error, warnings }
  }

  try {
    const vault = resolveVault(vaultKey())
    if (!vault?.path || !fs.existsSync(vault.path)) {
      return fail(500, `vault not available (${vault?.path || 'no VAULT_PATH'}) — the page has nowhere to land`)
    }
    assetsAbs = path.join(vault.path, assetsRel)
    pageAbs = path.join(vault.path, pageRel)

    let cookies
    try {
      cookies = cookieArgs()
    } catch (e) {
      return fail(500, String(e.message || e))
    }
    if (cookies.warning) warnings.push(cookies.warning)

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-kit-ig-${code}-`))

    // 1. Metadata — fatal. No caption and no post facts is not a page.
    let info
    try {
      info = await probeMetadata(url, cookies)
    } catch (e) {
      return fail(502, String(e.message || e))
    }

    const cap = limits().captionChars
    const captionTruncated = info.caption.length > cap
    const caption = captionTruncated ? info.caption.slice(0, cap) : info.caption
    if (!caption) warnings.push('the post carried no written caption')

    // 2. Stills — never fatal. A caption-only page still beats no page.
    const media = await fetchImages(url, tmp, cookies)
    if (media.warning) warnings.push(media.warning)

    // 3. Stage them at their final vault path, bounded by count and by bytes.
    //
    // The old directory is wiped ONLY when a new image is actually about to
    // replace it: a re-ingest that returns fewer slides than last time must not
    // leave orphans, but a re-ingest that fetched NOTHING must not delete a
    // previous run's images either — that would leave the vault with staged-less
    // tracked deletions, i.e. a dirty tree for the next writer to trip over.
    const { images: maxImages, imageBytes } = limits()
    const hadAssets = fs.existsSync(assetsAbs)
    const hadPage = fs.existsSync(pageAbs)
    const staged = []
    for (const file of media.files) {
      if (staged.length >= maxImages) {
        warnings.push(`the post has ${media.files.length} images — only the first ${maxImages} were kept (the vault is a git repo; blobs are permanent)`)
        break
      }
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        continue
      }
      if (size > imageBytes) {
        warnings.push(`skipped one image of ${Math.round(size / 1024)} KB — over the ${Math.round(imageBytes / 1024)} KB per-image limit`)
        continue
      }
      if (!staged.length) rmQuiet(assetsAbs)
      const name = assetName(staged.length, file)
      fs.mkdirSync(assetsAbs, { recursive: true })
      fs.copyFileSync(file, path.join(assetsAbs, name))
      staged.push(name)
    }
    /* Only artifacts THIS run created are removed when it fails: deleting a
     * previous ingest's committed page or images to tidy up a failed re-ingest
     * would destroy good content and leave tracked deletions behind. */
    cleanup = () => {
      if (!hadAssets) rmQuiet(assetsAbs)
      if (!hadPage) rmQuiet(pageAbs)
    }

    // 4. Analysis — best-effort, and its failure is stated on the page itself.
    const analysis = await analyze({
      url,
      caption,
      imageRels: staged.map((n) => `${assetsRel}/${n}`),
      cwd: vault.path,
    })
    if (!analysis.ok) {
      warnings.push(`no analysis: ${analysis.error}`)
      console.error(`[instagram-ingest] ${url}: analysis failed — ${analysis.error}`)
    }

    // 5. The page, through the serial commit queue — the vault's single writer.
    const markdown = renderPage({
      url,
      code,
      kind,
      caption,
      captionTruncated,
      analysis,
      images: staged,
      uploader: info.uploader,
      postedAt: isoFromUploadDate(info.uploadDate),
      ingestedAt: at,
      warnings,
    })
    const commit = await enqueueAtlasCommit({
      message: `sources: instagram ${code}`,
      // The assets pathspec is only passed when there ARE assets: `git add` on a
      // path that is in neither the worktree nor the index is a fatal error, and
      // that must not be how a caption-only ingest fails.
      paths: staged.length ? [pageRel, assetsRel] : [pageRel],
      vault: vaultKey(),
      mutate: async (atlas) => {
        const abs = path.join(atlas, pageRel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, markdown, 'utf-8')
      },
    })
    if (!commit.ok) {
      cleanup()
      return fail(500, commit.warning || 'the vault commit failed')
    }

    const record = appendRecord({
      at,
      url,
      code,
      ok: true,
      requestedBy,
      page: pageRel,
      slug: slugFor(code),
      title: (analysis.ok && analysis.title) || '',
      images: staged.length,
      caption: caption.length,
      analysis: analysis.ok,
      committed: !!commit.committed,
      warnings,
    })
    console.error(`[instagram-ingest] ${url} → ${pageRel} (${staged.length} image(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''})`)
    return { ok: true, status: 200, ...record }
  } catch (e) {
    // Anything unforeseen still cleans the vault up and still gets recorded.
    cleanup()
    return fail(500, `unexpected ingest failure: ${String(e?.message || e)}`)
  } finally {
    if (tmp) rmQuiet(tmp)
    running = false
  }
}
