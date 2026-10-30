import test from 'node:test'
import assert from 'node:assert/strict'

import { ask, helpText, overLimit, questionOf, replyText, LIMITS } from '../ask.mjs'
import { send, unlisted, LIST_MARK, POST_MAX } from '../post.mjs'

const NOW = new Date('2026-10-16T20:00:00Z') // 23:00 in Bucharest: outside the posting window

test('the question is what follows /skim or @skim', () => {
    assert.equal(questionOf('/skim cine joacă azi?'), 'cine joacă azi?')
    assert.equal(questionOf('@Skim: who won?'), 'who won?')
    assert.equal(questionOf('/skim'), '')
})

test('the reply says who asked, then the answer, then each link alone on its own line', () => {
    const text = replyText('Silviu', 'cine joacă?', { answer: 'Rush și Light.', links: ['https://a.example/1', 'not a link', 'https://b.example/2', 'https://c.example/3'] })
    assert.equal(text, '❓ Silviu: cine joacă?\n\nRush și Light.\n\nhttps://a.example/1\n\nhttps://b.example/2')
})

test('an answer goes at any hour, scores included, and a message is answered once', async () => {
    const sent = []
    const asked = {}
    const fetchImpl = async (url, { body }) => { sent.push(JSON.parse(body)); return { ok: true, json: async () => ({ sent: true }) } }
    const sender = (text, options) => send(text, { ...options, group: 'Noobz', fetchImpl, now: NOW })
    const model = async () => ({ language: 'en', answer: 'Rush beat Light 3-1.', links: [] })
    await ask({ id: 'm1', from: 'Andrei', text: '/skim who won?', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /Rush beat Light 3-1/)
    assert.equal(sent[0].agent, 'skim')
    const again = await ask({ id: 'm1', from: 'Andrei', text: '/skim who won?', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(again.skipped, 'already answered')
    assert.equal(sent.length, 1)
})

test('a failed search still answers, in the language it was asked in', async () => {
    let posted
    const model = async () => { throw new Error('down') }
    await ask({ text: '/skim când e finala?', now: NOW, asked: {}, save: () => {}, model, sender: async (t) => { posted = t; return { sent: true } } })
    assert.match(posted, /Nu am putut căuta acum/)
})

test('the group cannot run it in a loop', () => {
    const asked = Object.fromEntries(Array.from({ length: LIMITS.hour }, (_, i) => [`m${i}`, { at: new Date(NOW - i * 60e3).toISOString() }]))
    assert.equal(overLimit(asked, NOW), 'hour')
    assert.equal(overLimit({}, NOW), null)
})

test('over the limit, the first question hears it once, in its language; the next waits quietly', async () => {
    const asked = Object.fromEntries(Array.from({ length: LIMITS.hour }, (_, i) => [`m${i}`, { at: new Date(NOW - i * 60e3).toISOString() }]))
    const posted = []
    const sender = async (t) => { posted.push(t); return { sent: true } }
    const model = async () => { throw new Error('not asked') }
    await ask({ id: 'x1', text: '/skim cine joacă?', now: NOW, asked, save: () => {}, model, sender })
    await ask({ id: 'x2', text: '/skim who plays?', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(posted.length, 1)
    assert.match(posted[0], /Am răspuns la 15 întrebări în ultima oră/)
})

test('a question is answered from the bot\'s own records first: the players it names are looked up in its news and schedule (G-116)', async () => {
    const { ownRecords, prompt } = await import('../ask.mjs')
    const news = [
        { date: '2026-10-13', headline: 'soma beats Light 8-1 in Google Play special', summary: 'soma won the first eight games.', sources: ['https://eloboard.com/news/2026-10-14'] },
        { date: '2026-10-13', headline: 'Bisu beats Speed 4-2', summary: 'Long format PvT.', sources: [] },
    ]
    const matches = [{ date: '2026-10-13', kst: '21:00', bucharest: { time: '15:00' }, a: { id: 'Light', race: 'T' }, b: { id: 'soma', race: 'Z' }, competition: { name: 'Ultimate Battle' }, played: true }]
    const now = new Date('2026-10-16T12:00:00Z')
    const records = ownRecords('cât a fost scorul la ultimul showmatch Light vs Soma?', { news, matches, watchlist: { players: [] }, now })
    assert.match(records, /soma beats Light 8-1/)
    assert.match(records, /eloboard\.com\/news\/2026-10-14/)
    assert.match(records, /Light \(T\) vs soma \(Z\), Ultimate Battle, played/)
    assert.doesNotMatch(records, /Bisu/, 'only what is about the players asked about')
    assert.match(prompt('x', { now, records }), /Check these FIRST/)
    assert.doesNotMatch(prompt('x', { now, records: '' }), /Check these FIRST/, 'nothing recorded, nothing said')
})

test('Korean sources first for anything Korean; anywhere for StarCraft outside Korea (Silviu, 16 and 17 Oct)', async () => {
    const { prompt } = await import('../ask.mjs')
    const p = prompt('who won?', { now: new Date('2026-10-16T12:00:00Z'), records: '' })
    assert.match(p, /For anything Korean .* search in Korean first/)
    assert.match(p, /eloboard\.com/)
    assert.match(p, /search anywhere: Google, YouTube/)
    assert.match(p, /StarCraft anywhere in the world - Brood War and StarCraft II/)
    assert.doesNotMatch(p, /only answer about South Korea and Korean StarCraft/)
})

test('no result unless the question explicitly asks for one (Silviu, 17 Oct)', async () => {
    const { ownRecords, prompt, asksForResult, withoutResults } = await import('../ask.mjs')
    for (const q of ['who won soma vs Light?', 'did Rush win?', 'cât a fost scorul?', 'cine a câștigat ASL?', 'rezultatul de aseară?']) assert.ok(asksForResult(q), q)
    for (const q of ['when does soma play next?', 'Link to the soma goes into it on a 7-win streak. match?', 'ce face Flash azi?', 'unde văd finala ASL?']) assert.ok(!asksForResult(q), q)
    const news = [{ date: '2026-10-13', headline: 'soma beats Light 8-1 in Google Play special', summary: 'soma won the first eight games.', spoiler: true,
        card: 'soma and Light play a Google Play special', teaser: 'A long showmatch on SOOP.', sources: ['https://eloboard.com/news/2026-10-14'] }]
    const matches = [{ date: '2026-10-13', kst: '21:00', bucharest: { time: '15:00' }, a: { id: 'Light', race: 'T' }, b: { id: 'soma', race: 'Z' }, competition: { name: 'Ultimate Battle' }, played: true, result: { a: 1, b: 8 } }]
    const now = new Date('2026-10-16T12:00:00Z')
    const quiet = ownRecords('link to the soma vs Light match?', { news, matches, watchlist: { players: [] }, now })
    assert.match(quiet, /soma and Light play a Google Play special\. A long showmatch on SOOP/)
    assert.doesNotMatch(quiet, /8-1|1-8|beats|won/)
    assert.match(ownRecords('who won soma vs Light?', { news, matches, watchlist: { players: [] }, now }), /soma beats Light 8-1[\s\S]*Light 1-8 soma/)
    assert.match(prompt('when does soma play?', { now, records: '' }), /NO RESULTS/)
    assert.doesNotMatch(prompt('who won?', { now, records: '' }), /NO RESULTS/)
    assert.equal(withoutResults('Soma plays Light at 19:00 KST. Soma beat Light 8-1 last week. Watch on SOOP.'), 'Soma plays Light at 19:00 KST. Watch on SOOP.')
    // A time is never a score, wherever its zone is written (17 Oct: "what time" lost its answer).
    for (const t of ['Soulkey vs SnOw is on Monday, 21:00 KST, 15:00 in Bucharest.', 'Luni la 21:00 ora Coreei (15:00 la București).', 'It starts at 21:00, 15:00 for you.'])
        assert.equal(withoutResults(t), t, t)
    for (const t of ['Soulkey took it 3:1.', 'It ended 4-2.', 'Scorul a fost 3–0.'])
        assert.equal(withoutResults(t), '', t)

    const sent = []
    const sender = async (text) => { sent.push(text); return { sent: true } }
    const model = async () => ({ language: 'en', answer: 'Here is the VOD. soma won 8-1.', links: ['https://sooplive.com/x'] })
    await ask({ from: 'Andrei', text: '/skim link to the soma vs Light match?', now: NOW, asked: {}, save: () => {}, model, sender })
    assert.doesNotMatch(sent[0], /8-1|won/)
    assert.match(sent[0], /Here is the VOD\./)
})

test('university team results are the exception: given unasked, as in the group posts (Silviu, 17 Oct)', async () => {
    const { ownRecords, teamResults, withoutResults } = await import('../ask.mjs')
    const news = [{ date: '2026-10-15', headline: 'Dreamz beat Calm MonstarZ 4-2', summary: 'Rush won the ace match.', spoiler: true,
        card: 'Dreamz and Calm MonstarZ meet in the University Clash', teaser: null, teamResult: 'University Clash: Dreamz 4-2 Calm MonstarZ' }]
    const records = ownRecords('what is new in the university leagues?', { news, matches: [], watchlist: { players: [] }, now: new Date('2026-10-16T12:00:00Z') })
    assert.match(records, /University result: University Clash: Dreamz 4-2 Calm MonstarZ/)
    assert.doesNotMatch(records, /Rush won/, 'not the player games')
    const known = teamResults(news)
    assert.equal(withoutResults('Dreamz beat Calm MonstarZ 4-2. Rush won the ace 2-0. More next week.', known), 'Dreamz beat Calm MonstarZ 4-2. More next week.')
})

test('/skim help says what the bot does, without the model, in English or Romanian (F-344)', async () => {
    const posted = []
    const model = async () => { throw new Error('the model is not asked for help') }
    const sender = async (t) => { posted.push(t); return { sent: true } }
    const asked = {}
    for (const text of ['/skim help', '/skim', '@skim ?', '/skim ajutor']) {
        await ask({ id: text, from: 'Andrei', text, now: NOW, asked, save: () => {}, model, sender })
    }
    assert.equal(posted.length, 4)
    assert.match(posted[0], /^🤖 \*Skim Bot\* - what I can do/)
    assert.equal(posted[1], posted[0])
    assert.equal(posted[2], posted[0])
    assert.match(posted[3], /^🤖 \*Skim Bot\* - ce știu să fac/)
    for (const text of posted) {
        assert.match(text, /\/skim /, 'it shows how to ask')
        assert.match(text, new RegExp(`${LIMITS.hour}.*${LIMITS.day}`))
        // The link alone on its own line, a blank line above it.
        assert.match(text, /\n\nhttps:\/\/decemvre\.github\.io\/skim-sc\/$/)
    }
    assert.equal(overLimit(asked, NOW), null)
    assert.ok(Object.values(asked).every((a) => a.help), 'help is remembered, so it is answered once')
})

test('help is not counted towards the limits, and a real question with "help" in it is still a question', async () => {
    const asked = Object.fromEntries(Array.from({ length: LIMITS.hour }, (_, i) => [`h${i}`, { at: NOW.toISOString(), help: true }]))
    assert.equal(overLimit(asked, NOW), null)
    let prompted = false
    const model = async () => { prompted = true; return { language: 'en', answer: 'Use the observer.', links: [] } }
    await ask({ text: '/skim help me find the ASL VODs', now: NOW, asked: {}, save: () => {}, model, sender: async () => ({ sent: true }) })
    assert.ok(prompted)
})

test('/skim help lists the two video forms, in English and Romanian (X-134)', async () => {
    const posted = []
    for (const text of ['/skim help', '/skim ajutor']) {
        await ask({ id: text, text, now: NOW, asked: {}, save: () => {}, model: async () => { throw new Error('no model') }, sender: async (t) => { posted.push(t); return { sent: true } } })
    }
    assert.match(posted[0], /\n\/skim <YouTube link> - that video\n\/skim yt - the nearest YouTube link above it\n/)
    assert.match(posted[1], /\n\/skim <link YouTube> - acel video\n\/skim yt - cel mai apropiat link YouTube de deasupra\n/)
})

test('/skim yt with no YouTube link above it (the bridge sends only those here) is said in one line, once, without the model or the limits (X-134)', async () => {
    const posted = []
    const asked = {}
    const model = async () => { throw new Error('the model is not asked') }
    const sender = async (t) => { posted.push(t); return { sent: true } }
    const r = await ask({ id: 'm1', from: 'Andrei', text: '/skim yt', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(r.reply, '🎬 Andrei: I found no YouTube link above your /skim yt.')
    assert.deepEqual(await ask({ id: 'm1', from: 'Andrei', text: '/skim yt', now: NOW, asked, save: () => {}, model, sender }), { skipped: 'already answered' })
    assert.equal(posted.length, 1)
    assert.equal(overLimit(asked, NOW), null)
    let prompted = false
    await ask({ text: '/skim ytb sau twitch?', now: NOW, asked: {}, save: () => {}, model: async () => { prompted = true; return { language: 'ro', answer: 'SOOP.', links: [] } }, sender })
    assert.ok(prompted, 'a question starting with yt is still a question')
})

test('the whole help reaches the bridge, in order, in parts WhatsApp sends as typed (B-355)', async () => {
    for (const ro of [false, true]) {
        const help = helpText(ro)
        const typed = []
        const fetchImpl = async (url, { body }) => { typed.push(JSON.parse(body).text); return { ok: true, json: async () => ({ sent: true, status: 'sent' }) } }
        const r = await send(help, { group: 'Noobz', fetchImpl, asked: true })
        assert.equal(r.sent, true)
        assert.ok(typed.length > 1, 'the help is longer than one message')
        assert.equal(typed.join('\n\n'), help, 'nothing left out, nothing reordered')
        for (const part of typed) {
            assert.ok(part.length <= POST_MAX, `${part.length} characters`)
            assert.doesNotMatch(part, new RegExp(LIST_MARK.source, 'm'), 'no line WhatsApp would make a list')
        }
        assert.match(typed.at(-1), /https:\/\/decemvre\.github\.io\/skim-sc\/$/, 'the site link closes it')
        assert.ok(typed.some((p) => p.includes(ro ? '*Videoclipuri*' : '*YouTube videos*')))
        assert.ok(typed.some((p) => p.includes(ro ? '*Singur*' : '*On my own*')))
    }
})

test('a line typed as a list item goes with "▸", bold and dashes inside a line stay (B-355)', () => {
    assert.equal(unlisted('Top:\n• Rush\n- Flash\n* Soulkey\n  - Light'), 'Top:\n▸ Rush\n▸ Flash\n▸ Soulkey\n  ▸ Light')
    assert.equal(unlisted('*Skim Bot* - what I can do\n-5 °C in Seoul\n/skim yt - the link above'), '*Skim Bot* - what I can do\n-5 °C in Seoul\n/skim yt - the link above')
})

test('/skim help arrives whole: every part is posted, in order, and the last is the videos and the page (B-355)', async () => {
    const { send, LIST_MARK } = await import('../post.mjs')
    for (const ro of [false, true]) {
        const posted = []
        const fetchImpl = async (url, { body }) => {
            posted.push(JSON.parse(body).text)
            return { ok: true, status: 200, json: async () => ({ sent: true, status: 'sent' }) }
        }
        const r = await send(helpText(ro), { group: 'Test group', fetchImpl, asked: true })
        assert.equal(r.sent, true)
        assert.equal(posted.length, r.parts ?? 1)
        assert.ok(posted.length >= 3, `${posted.length} parts`)
        assert.match(posted.at(-1), ro ? /\*Videoclipuri\*/ : /\*YouTube videos\*/)
        assert.match(posted.at(-1), /https:\/\/\S+$/)
        for (const part of posted) assert.doesNotMatch(part, LIST_MARK, 'a list-like line would stop the post')
        assert.equal(posted.join('\n\n').replace(/\s+/g, ' '), helpText(ro).replace(/\s+/g, ' '), 'nothing lost between the parts')
    }
})
