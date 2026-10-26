import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { delayFor, fileName, handle, replyText, retry, tooBig, videoId, KEEP, MAX_SECONDS } from '../video.mjs'
import { Digi, FOLDER } from '../lib/digistorage.mjs'

test('every YouTube link form gives its video id; anything else gives none', () => {
    for (const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/watch?feature=share&v=jNQXAC9IVRw&t=3',
        'https://youtu.be/jNQXAC9IVRw?si=abc', 'https://www.youtube.com/shorts/jNQXAC9IVRw', 'https://m.youtube.com/watch?v=jNQXAC9IVRw',
        'https://music.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/live/jNQXAC9IVRw']) assert.equal(videoId(url), 'jNQXAC9IVRw', url)
    for (const url of ['https://www.youtube.com/@channel', 'https://youtube.com/playlist?list=PL123', 'https://vimeo.com/123', 'https://youtu.be/short']) assert.equal(videoId(url), null, url)
})

test('the reply is who posted it and the title, then the link alone on its own line', () => {
    assert.equal(replyText('Andrei', 'Me at the zoo', 'https://storage.rcs-rds.ro/links/x'), '🎬 Andrei: Me at the zoo\n\nhttps://storage.rcs-rds.ro/links/x')
    assert.equal(fileName('a/b: "c"?', 'jNQXAC9IVRw'), 'a b c [jNQXAC9IVRw].mp4')
})

test('limits: over 2 h, a live stream or over 2 GB is not saved', () => {
    assert.equal(tooBig({ duration: 600, bytes: 1e8 }), null)
    assert.match(tooBig({ duration: MAX_SECONDS + 1 }), /over 2 h/)
    assert.match(tooBig({ live: true, duration: 10 }), /live/)
    assert.match(tooBig({ duration: 60, bytes: 3 * 1024 ** 3 }), /over 2 GB/)
})

test('retries double with jitter up to a cap, stop at the limit, and never retry a permanent failure', async () => {
    assert.equal(delayFor(1, { random: () => 1 }), 30000)
    assert.equal(delayFor(2, { random: () => 1 }), 60000)
    assert.equal(delayFor(10, { random: () => 1 }), 8 * 60000)
    assert.equal(delayFor(1, { random: () => 0 }), 15000)
    const waits = []
    let n = 0
    await assert.rejects(retry(async () => { n++; throw new Error('down') }, { attempts: 3, wait: async (ms) => waits.push(ms) }), /down/)
    assert.equal(n, 3)
    assert.equal(waits.length, 2)
})

test('only files directly inside the folder can ever be deleted', () => {
    assert.ok(Digi.inFolder(`${FOLDER}/a [x].mp4`))
    for (const p of ['/!SAVE/a.mp4', `${FOLDER}/`, `${FOLDER}/../SWARMSOFT/x`, `${FOLDER}/sub/a.mp4`, `${FOLDER} 2/a.mp4`, '/Skim videosx/a.mp4']) assert.ok(!Digi.inFolder(p), p)
})

// A Digi Cloud that keeps files in memory; and yt-dlp that writes a small file.
function fakes ({ files = [] } = {}) {
    const store = new Map(files.map((f) => [f.path, f]))
    const links = []
    let clock = 1000
    const digi = {
        info: async (path) => store.get(path) || null,
        ensureFolder: async () => {},
        free: async () => 10 * 1024 ** 3,
        upload: async (file, { name, size }) => { const path = `${FOLDER}/${name}`; store.set(path, { path, size, modified: clock++ }); return { path } },
        link: async (path) => { const l = links.find((x) => x.path === path) || { path, url: `https://storage.rcs-rds.ro/links/${links.length + 1}` }; links.includes(l) || links.push(l); return { url: l.url } },
        prune: async (keep) => {
            const old = [...store.values()].sort((a, b) => b.modified - a.modified).slice(keep).map((f) => f.path)
            for (const p of old) store.delete(p)
            return old
        },
    }
    const runner = async (cmd, args) => {
        if (args.includes('-J')) return JSON.stringify({ id: 'jNQXAC9IVRw', title: 'Me at the zoo', duration: 19, live_status: 'not_live', requested_formats: [{ filesize: 1000 }] })
        const out = args[args.indexOf('-o') + 1].replace('%(id)s.%(ext)s', 'jNQXAC9IVRw.mp4')
        writeFileSync(out, 'x'.repeat(1000)); writeFileSync(out + '.part', 'y')
        return ''
    }
    return { digi, runner, store, links }
}

test('a link is downloaded, uploaded, linked and replied to; the same video again gets the same link; nothing stays on disk', async () => {
    const work = mkdtempSync(join(tmpdir(), 'skim-video-'))
    const { digi, runner, store } = fakes()
    const sent = []
    const sender = async (text) => { sent.push(text); return { sent: true } }
    const videos = {}
    const r = await handle({ url: 'https://youtu.be/jNQXAC9IVRw', from: 'Andrei', videos, save: () => {}, digi, sender, runner, work, log: () => {} })
    assert.equal(r.link, 'https://storage.rcs-rds.ro/links/1')
    assert.deepEqual(sent, ['🎬 Andrei: Me at the zoo\n\nhttps://storage.rcs-rds.ro/links/1'])
    assert.ok(store.has(`${FOLDER}/Me at the zoo [jNQXAC9IVRw].mp4`))
    assert.deepEqual(readdirSync(work), [])

    const again = await handle({ url: 'https://www.youtube.com/shorts/jNQXAC9IVRw', from: 'Mihai', videos, save: () => {}, digi, sender, runner: async () => { throw new Error('should not download') }, work, log: () => {} })
    assert.equal(again.reused, true)
    assert.equal(sent[1], '🎬 Mihai: Me at the zoo\n\nhttps://storage.rcs-rds.ro/links/1')
})

test('a failure is one short note, after the retries, and the local copy is deleted too', async () => {
    const work = mkdtempSync(join(tmpdir(), 'skim-video-'))
    const { digi, runner } = fakes()
    digi.upload = async () => { throw new Error('503') }
    const sent = []
    const r = await handle({ url: 'https://youtu.be/jNQXAC9IVRw', videos: {}, save: () => {}, digi, sender: async (t) => { sent.push(t); return { sent: true } }, runner, work, wait: async () => {}, log: () => {} })
    assert.equal(r.failed, '503')
    assert.deepEqual(sent, ['🎬 Me at the zoo - could not be saved just now.'])
    assert.deepEqual(readdirSync(work), [])
})

test('too long: a note, nothing downloaded', async () => {
    const work = mkdtempSync(join(tmpdir(), 'skim-video-'))
    const sent = []
    const runner = async (cmd, args) => { assert.ok(args.includes('-J')); return JSON.stringify({ title: 'Long', duration: MAX_SECONDS + 60 }) }
    const r = await handle({ url: 'https://youtu.be/jNQXAC9IVRw', videos: {}, save: () => {}, digi: {}, sender: async (t) => { sent.push(t); return { sent: true } }, runner, work, log: () => {} })
    assert.match(r.skipped, /over 2 h/)
    assert.deepEqual(sent, ['🎬 Long - it is over 2 h long, so it was not saved.'])
    assert.ok(!existsSync(join(work, `jNQXAC9IVRw-${process.pid}`)))
})

test(`at most ${KEEP} in the folder: the oldest goes and its record with it`, async () => {
    const work = mkdtempSync(join(tmpdir(), 'skim-video-'))
    const files = Array.from({ length: KEEP }, (_, i) => ({ path: `${FOLDER}/old${i}.mp4`, size: 1, modified: i }))
    const { digi, runner, store } = fakes({ files })
    const videos = { oldest: { path: `${FOLDER}/old0.mp4`, link: 'https://x/old', title: 'old' } }
    await handle({ url: 'https://youtu.be/jNQXAC9IVRw', videos, save: () => {}, digi, sender: async () => ({ sent: true }), runner, work, log: () => {} })
    assert.equal(store.size, KEEP)
    assert.ok(!store.has(`${FOLDER}/old0.mp4`))
    assert.equal(videos.oldest, undefined)
    assert.ok(videos.jNQXAC9IVRw)
})

test('the Digi Cloud client: rclone koofr/digistorage, password obscured on stdin; links lose their password; prune deletes only the oldest, links and all', async () => {
    const calls = []
    const L = '2d1fae68-fab1-4b8b-9408-07376d742828'
    const runner = async (cmd, args, { env, input } = {}) => {
        calls.push({ args, env, input })
        if (args[0] === 'obscure') return 'OBSCURED\n'
        if (args[0] === 'lsjson') return JSON.stringify([{ Name: 'new.mp4', ModTime: '2026-10-26T08:00:00Z' }, { Name: 'old.mp4', ModTime: '2026-10-25T08:00:00Z' }])
        if (args[0] === 'link') return `https://storage.example/content/links/${L}/files/get?path=%2F\n`
        return ''
    }
    const api = []
    const fetchImpl = async (url, { method, headers }) => {
        api.push(`${method} ${url.pathname}`)
        assert.equal(headers.Authorization, 'Basic ' + Buffer.from('a@b.ro:secret').toString('base64'))
        const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) })
        if (url.pathname === '/api/v2/mounts') return json({ mounts: [{ id: 'm1', isPrimary: true }] })
        if (url.pathname === '/api/v2/mounts/m1/links' && method === 'GET') return json({ links: [{ id: 'old1', path: `${FOLDER}/old.mp4` }, { id: 'save', path: '/!SAVE/x' }] })
        if (url.pathname === `/api/v2/mounts/m1/links/${L}` && method === 'GET') return json({ url: `https://storage.example/links/${L}`, hasPassword: false, validTo: 123 })
        return json({})
    }
    const digi = new Digi({ creds: { user: 'a@b.ro', password: 'secret' }, runner, fetchImpl, base: 'https://storage.example' })
    await digi.ensureFolder()
    assert.deepEqual(calls[0], { args: ['obscure', '-'], env: undefined, input: 'secret' })
    assert.deepEqual(calls[1].args, ['mkdir', ':koofr:Skim videos'])
    assert.equal(calls[1].env.RCLONE_KOOFR_PROVIDER, 'digistorage')
    assert.equal(calls[1].env.RCLONE_KOOFR_PASSWORD, 'OBSCURED')
    assert.equal(calls[1].env.RCLONE_KOOFR_SETMTIME, 'false')
    assert.deepEqual(await digi.link(`${FOLDER}/new.mp4`), { url: `https://storage.example/links/${L}`, validTo: 123 })
    assert.ok(api.includes(`DELETE /api/v2/mounts/m1/links/${L}/password`))
    calls.length = 0; api.length = 0
    assert.deepEqual(await digi.prune(1), [`${FOLDER}/old.mp4`])
    assert.deepEqual(calls.map((c) => c.args.join(' ')), ['lsjson --files-only --no-mimetype :koofr:Skim videos', 'deletefile :koofr:Skim videos/old.mp4'])
    assert.deepEqual(api.filter((a) => a.startsWith('DELETE')), ['DELETE /api/v2/mounts/m1/links/old1'])
    assert.ok(!calls.some((c) => c.args.some((a) => a.includes('secret'))), 'the password is never on a command line')
})

test('a link posted again near the end of its 14 days is made again', async () => {
    const work = mkdtempSync(join(tmpdir(), 'skim-video-'))
    const { digi, runner } = fakes({ files: [{ path: `${FOLDER}/z.mp4`, size: 1, modified: 1 }] })
    let unlinked = 0
    digi.unlink = async () => { unlinked++ }
    digi.link = async () => ({ url: 'https://storage.rcs-rds.ro/links/new', validTo: Date.now() + 14 * 86400e3 })
    const videos = { jNQXAC9IVRw: { title: 'Z', path: `${FOLDER}/z.mp4`, link: 'https://storage.rcs-rds.ro/links/old', validTo: Date.now() + 3600e3 } }
    const sent = []
    await handle({ url: 'https://youtu.be/jNQXAC9IVRw', videos, save: () => {}, digi, sender: async (t) => { sent.push(t); return { sent: true } }, runner, work, log: () => {} })
    assert.equal(unlinked, 1)
    assert.deepEqual(sent, ['🎬 Z\n\nhttps://storage.rcs-rds.ro/links/new'])
})
