import test from 'node:test'
import assert from 'node:assert/strict'

import { startsLine, topMatch, topIds, upcomingLines } from '../lib/importance.mjs'
import { ownRecords, prompt } from '../ask.mjs'

// 26 Oct 2026, 09:23 in Bucharest: "/skim Any important showmatches today?"
const NOW = new Date('2026-10-26T07:23:00Z')
const watchlist = { players: [{ id: 'Rush' }, { id: 'Soulkey' }, { id: 'Light' }], teams: [] }
const p = (id, race) => ({ id, race })
const matches = [
    { date: '2026-10-26', kst: '19:00', at: '2026-10-26T10:00:00Z', a: null, b: null, titleEn: 'Mini-Match Dreamz vs JSA Mini-Match', competition: { name: 'Mini-Match Dreamz vs JSA Mini-Match', big: false } },
    { date: '2026-10-26', kst: '18:00', at: '2026-10-26T09:00:00Z', a: p('Light', 'T'), b: p('Nobody', 'Z'), competition: { name: 'ASL Season 22', big: true } },
    { date: '2026-10-26', kst: '21:00', at: '2026-10-26T12:00:00Z', a: p('Soulkey', 'Z'), b: p('Rush', 'T'), competition: { name: 'Ultimate Battle', big: false, watch: 'https://www.sooplive.com/station/talent' } },
]

test('a 1v1 between two tracked top players is top-level: both sides are checked', () => {
    const top = topIds(watchlist)
    assert.ok(topMatch(matches[2], top))
    assert.ok(!topMatch(matches[1], top), 'one tracked player is not enough')
    assert.ok(!topMatch(matches[0], top), 'a team match is not a 1v1')
    assert.ok(topMatch({ a: p('rush'), b: p('LIGHT') }, top), 'IDs match whatever their case')
})

test('Soulkey vs Rush, a showmatch, comes before a league game and before Dreamz vs JSA', () => {
    const lines = upcomingLines(matches, { watchlist, now: NOW })
    assert.match(lines[0], /^- \[TOP-LEVEL 1v1[^\]]*MORE important than any league game\] Soulkey \(Z\) vs Rush \(T\), Ultimate Battle/)
    assert.match(lines[1], /big competition\] Light/)
    assert.match(lines[2], /minor\] Mini-Match Dreamz vs JSA/)
})

test('a start is its Bucharest time and how long until it - not "from now" beside a Korea time', () => {
    assert.equal(startsLine(matches[2], NOW), '14:00 Bucharest, in 4 h 37 min')
    assert.equal(startsLine({ at: '2026-10-26T07:30:00Z' }, NOW), '09:30 Bucharest, in 7 min')
    assert.equal(startsLine({ at: '2026-10-26T07:00:00Z' }, NOW), '09:00 Bucharest, started 23 min ago')
    assert.ok(upcomingLines(matches, { watchlist, now: NOW }).every((l) => !/KST/.test(l)))
})

test('asked about important showmatches with no player named, the model still gets the schedule, and the rule', () => {
    const records = ownRecords('Any important showmatches today?', { news: [], matches, watchlist, now: NOW })
    assert.match(records, /MOST IMPORTANT FIRST[\s\S]*Soulkey \(Z\) vs Rush \(T\)[\s\S]*Dreamz vs JSA/)
    const text = prompt('Any important showmatches today?', { watchlist, now: NOW, records })
    assert.match(text, /MORE important than anything else, league games included/)
    assert.match(text, /Never call one less important because it is a showmatch/)
    assert.match(text, /14:00 Bucharest, in 4 h 37 min/)
})

test('everywhere else too: a top-player 1v1 is major - in a weekend morning post, first, and it gets its reminder', async () => {
    const { morningText, dueReminders } = await import('../post.mjs')
    const day = [
        { key: 'a', date: '2026-10-25', kst: '18:00', at: '2026-10-25T09:00:00Z', onSchedule: true, bucharest: { time: '?', zone: 'EEST' }, a: p('Light', 'T'), b: p('Nobody', 'Z'), competition: { name: 'ASL Season 22', big: true } },
        { key: 'b', date: '2026-10-25', kst: '20:00', at: '2026-10-25T11:00:00Z', onSchedule: true, bucharest: { time: '?', zone: 'EEST' }, a: p('Mini', 'P'), b: p('Nobody', 'Z'), competition: { name: 'Some cup', big: false } },
        { key: 'c', date: '2026-10-25', kst: '21:00', at: '2026-10-25T12:00:00Z', onSchedule: true, bucharest: { time: '?', zone: 'EEST' }, a: p('Soulkey', 'Z'), b: p('Rush', 'T'), competition: { name: 'Ultimate Battle', big: false } },
    ]
    const text = morningText(day, [], '2026-10-25', { weekend: true, watchlist })
    assert.match(text, /Soulkey \(Z\) vs Rush \(T\)[\s\S]*Light \(T\) vs Nobody \(Z\)/, 'the top 1v1 first')
    assert.doesNotMatch(text, /Mini/, 'a minor match still stays out on a weekend')
    const due = dueReminders(day, { reminders: {} }, new Date('2026-10-25T11:45:00Z'), watchlist)
    assert.deepEqual(due.map((m) => m.key), ['c'])
})
