#!/usr/bin/env node
// Skim Bot, F-535: a YouTube link posted in the group comes back as a Digi Cloud link to the video,
// for the four of them only (Silviu, 26 Oct 2026).
//
//   1. The WhatsApp bridge sees the link (office/whatsapp-bridge/skim-asks.mjs: of a message that
//      is not /skim it reads only its YouTube URLs, never its text) and runs this once per link,
//      one at a time, apart from /skim questions so a long download never holds an answer up.
//   2. yt-dlp, 720p at most, mp4 (H.264 first, so it plays on every phone and in the browser).
//      Not over MAX_SECONDS long, not over MAX_BYTES, not a live stream: those get a short note.
//   3. Uploaded to Digi Cloud, folder "Skim videos" (made the first time), and a link made to it:
//      anyone with the link can watch or download it without logging in; it is listed nowhere.
//   4. The reply in the group: who posted it, the title, and the link alone on its own line.
//   5. The local copy is deleted whatever happens - after the upload, or after the last retry
//      failed: partials and temp files too. Nothing stays on disk (Silviu, 26 Oct).
//   6. At most KEEP videos stay in the folder: the oldest by upload time go, links and all.
//
// The same video posted again - any link form - gets the link made the first time (by video id).
// Each step that can fail for a while is retried with a doubling delay, jitter, a cap and a
// limit; a failure for good is one short note in the group and a line in the log.
//
//   node bot/video.mjs --id <message id> --from <who posted it> -- <url>
//   node bot/video.mjs --no-post -- <url>        everything, but the reply is printed, not sent
//   node bot/video.mjs --download-only -- <url>  only the download (then deleted): no login needed

import { execFile } from 'node:child_process'
import { mkdirSync, openAsBlob, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { send } from './post.mjs'
import { Digi, FOLDER, MissingCredentials } from './lib/digistorage.mjs'

export const VIDEOS_FILE = fileURLToPath(new URL('./data/videos.json', import.meta.url))
export const WORK = process.env.SKIM_VIDEO_WORK || join(homedir(), '.cache/skim-bot/videos')
export const YTDLP = process.env.YTDLP || join(homedir(), '.local/bin/yt-dlp')
export const MAX_SECONDS = 2 * 3600
export const MAX_BYTES = 2 * 1024 ** 3
export const KEEP = 20
export const FORMAT = 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]'
// What a retry waits: 30 s, 60 s, 120 s... capped at 8 min, with jitter; 3 tries of a download,
// 4 of the upload (it resumes nothing, but a file already there is not sent again).
export const RETRY = { base: 30000, cap: 8 * 60000, download: 3, upload: 4 }
// A leftover work folder (a run killed past its own clean-up) is swept by the next run after this.
const STALE_MS = 4 * 3600e3

// The video id of a YouTube link, or null: watch?v=, youtu.be/, /shorts/, /live/, /embed/,
// on www., m. or music.
const LINK = /https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:\S*?&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i
export const videoId = (url) => String(url || '').match(LINK)?.[1] || null
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`

// A good name in a folder: the title, then the id, which keeps two videos of one title apart.
export const fileName = (title, id) => `${String(title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video'} [${id}].mp4`

export const replyText = (from, title, url) => [`🎬 ${from ? from + ': ' : ''}${title}`, '', url].join('\n')
export const noteText = (from, title, why) => `🎬 ${from ? from + ': ' : ''}${title ? title + ' - ' : ''}${why}`

// For good, not for a while: retrying changes nothing.
export class Permanent extends Error {}

export const delayFor = (attempt, { base = RETRY.base, cap = RETRY.cap, random = Math.random } = {}) => {
    const d = Math.min(cap, base * 2 ** (attempt - 1))
    return Math.round(d / 2 + random() * d / 2)
}

export async function retry (fn, { attempts, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, label = 'step', ...delay }) {
    for (let attempt = 1; ; attempt++) {
        try { return await fn(attempt) } catch (error) {
            if (error instanceof Permanent || error instanceof MissingCredentials || attempt >= attempts) throw error
            const ms = delayFor(attempt, delay)
            log(`${label}: attempt ${attempt} of ${attempts} failed (${error.message}); again in ${Math.round(ms / 1000)} s`)
            await wait(ms)
        }
    }
}

function run (cmd, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (!error) return resolve(stdout)
            const last = String(stderr || error.message).trim().split('\n').filter((l) => /ERROR|error/.test(l)).slice(-1)[0] || error.message
            const E = /unavailable|private video|removed|terminated|copyright|sign in to confirm your age|members-only|not available in your country/i.test(last) ? Permanent : Error
            reject(new E(last.replace(/^ERROR:\s*/, '').slice(0, 200)))
        })
    })
}

const ytArgs = () => ['--no-playlist', '--no-warnings', '--js-runtimes', `node:${process.execPath}`]

// What the video is, before anything is downloaded.
export async function probe (id, { runner = run } = {}) {
    const info = JSON.parse(await runner(YTDLP, [...ytArgs(), '-J', '-f', FORMAT, watchUrl(id)], 3 * 60000))
    const parts = info.requested_formats || [info]
    const bytes = parts.reduce((s, f) => s + (f.filesize || f.filesize_approx || 0), 0) || null
    return { id: info.id || id, title: info.title || id, duration: info.duration || null, live: ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status), bytes }
}

// Why a video is not saved, or null.
export function tooBig (v) {
    if (v.live) return 'a live stream is not saved.'
    if (!v.duration) return 'its length is unknown, so it was not saved.'
    if (v.duration > MAX_SECONDS) return `it is over ${MAX_SECONDS / 3600} h long, so it was not saved.`
    if (v.bytes && v.bytes > MAX_BYTES) return `it is over ${MAX_BYTES / 1024 ** 3} GB at 720p, so it was not saved.`
    return null
}

export async function download (id, dir, { runner = run } = {}) {
    mkdirSync(dir, { recursive: true })
    const free = statfsSync(dir)
    if (free.bavail * free.bsize < MAX_BYTES * 2 + 1024 ** 3) throw new Error('not enough free disk to download')
    await runner(YTDLP, [...ytArgs(), '--no-progress', '-f', FORMAT, '--merge-output-format', 'mp4', '--max-filesize', `${MAX_BYTES}`,
        '-o', join(dir, '%(id)s.%(ext)s'), watchUrl(id)], 45 * 60000)
    const file = readdirSync(dir).map((f) => join(dir, f)).find((f) => f.endsWith('.mp4'))
    // --max-filesize skips quietly: no file is a video over the cap.
    if (!file) throw new Permanent(`over ${MAX_BYTES / 1024 ** 3} GB at 720p, so it was not saved.`)
    return { file, size: statSync(file).size }
}

export const loadVideos = (file = VIDEOS_FILE) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
const saveVideos = (v, file = VIDEOS_FILE) => writeFileSync(file, JSON.stringify(v, null, 2) + '\n')

// Leftovers of a run that was killed before it cleaned up.
export function sweep (work = WORK, now = Date.now()) {
    try {
        for (const d of readdirSync(work)) {
            const p = join(work, d)
            if (now - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true })
        }
    } catch { /* nothing there yet */ }
}

export async function handle ({ url, from = '', dryPost = false, downloadOnly = false, videos = loadVideos(), save = saveVideos,
    digi = null, sender = send, runner = run, wait, log = console.error, work = WORK } = {}) {
    const id = videoId(url)
    if (!id) return { skipped: 'not a YouTube video link' }
    const post = async (text) => sender(text, { asked: true, dryRun: dryPost })
    sweep(work)
    const dir = join(work, `${id}-${process.pid}`)
    const clean = () => rmSync(dir, { recursive: true, force: true })
    const onKill = () => { clean(); process.exit(143) }
    process.once('SIGTERM', onKill)
    let title = ''
    try {
        // Posted before and still in the folder: the same link again.
        const known = videos[id]
        if (known?.link && !downloadOnly) {
            digi ||= new Digi()
            if (await retry(() => digi.info(known.path), { attempts: RETRY.upload, wait, log, label: 'check' })) {
                log(`video ${id}: posted before, same link`)
                return { id, reused: true, link: known.link, ...await post(replyText(from, known.title, known.link)) }
            }
            delete videos[id]; save(videos)
        }
        const v = await retry(() => probe(id, { runner }), { attempts: RETRY.download, wait, log, label: 'probe' })
        title = v.title
        const why = tooBig(v)
        if (why) { log(`video ${id}: skipped - ${why}`); return { id, skipped: why, ...(downloadOnly ? {} : await post(noteText(from, title, why))) } }
        const got = await retry(() => download(id, dir, { runner }), { attempts: RETRY.download, wait, log, label: 'download' })
        log(`video ${id}: downloaded ${(got.size / 1024 ** 2).toFixed(1)} MB`)
        if (downloadOnly) return { id, title, duration: v.duration, size: got.size, downloaded: true }
        digi ||= new Digi()
        const name = fileName(title, id)
        const up = await retry(async () => {
            await digi.ensureFolder(FOLDER)
            const free = await digi.free()
            if (free !== null && free < got.size) throw new Permanent('Digi Cloud is full.')
            return digi.upload(got.file, { name, size: got.size, open: () => openAsBlob(got.file, { type: 'video/mp4' }) })
        }, { attempts: RETRY.upload, wait, log, label: 'upload' })
        clean()
        const link = await retry(() => digi.link(up.path), { attempts: RETRY.upload, wait, log, label: 'link' })
        videos[id] = { title, path: up.path, link: link.url, at: new Date().toISOString() }
        save(videos)
        // At most KEEP in the folder: the oldest go, and with them their record here.
        try {
            const gone = await retry(() => digi.prune(KEEP), { attempts: RETRY.upload, wait, log, label: 'prune' })
            if (gone.length) {
                for (const [vid, r] of Object.entries(videos)) if (gone.includes(r.path)) delete videos[vid]
                save(videos)
                log(`video ${id}: ${gone.length} old video(s) removed to keep ${KEEP}`)
            }
        } catch (error) { log(`video ${id}: prune failed - ${error.message}`) }
        log(`video ${id}: uploaded to ${up.path}`)
        return { id, title, link: link.url, ...await post(replyText(from, title, link.url)) }
    } catch (error) {
        log(`video ${id}: FAILED - ${error.message}`)
        if (downloadOnly) throw error
        const why = error instanceof Permanent ? error.message : 'could not be saved just now.'
        return { id, failed: error.message, ...await post(noteText(from, title, why)).catch((e) => ({ sent: false, why: e.message })) }
    } finally {
        clean()
        process.removeListener('SIGTERM', onKill)
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const args = process.argv.slice(2)
    const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
    const split = args.indexOf('--')
    const url = split >= 0 ? args.slice(split + 1).join(' ') : ''
    const result = await handle({ url, from: flag('--from') || '', dryPost: args.includes('--no-post'), downloadOnly: args.includes('--download-only') })
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.failed ? 1 : 0)
}
