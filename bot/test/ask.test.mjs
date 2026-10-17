import test from 'node:test'
import assert from 'node:assert/strict'

import { ask, overLimit, questionOf, replyText, LIMITS } from '../ask.mjs'
import { send } from '../post.mjs'

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

test('the search is Korean first; Liquipedia and tl.net are only a back-up (Silviu, 16 Oct)', async () => {
    const { prompt } = await import('../ask.mjs')
    const p = prompt('who won?', { now: new Date('2026-10-16T12:00:00Z'), records: '' })
    assert.match(p, /Search in Korean, and almost only in Korean/)
    assert.match(p, /eloboard\.com/)
    assert.match(p, /Liquipedia and TeamLiquid \(tl\.net\) are a back-up only/)
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
