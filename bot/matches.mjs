#!/usr/bin/env node
// Skim Bot, F-231: the Brood War matches in Korea, from SOOP's official schedule, with the
// players under the IDs we know them by. No model involved: the schedule is read, names are
// matched against Liquipedia once and remembered (lib/names.mjs), times are converted.
//
//   node bot/matches.mjs            refresh data/matches.json, print what changed and today's
//   node bot/matches.mjs --today    only print today's (KST) matches from the saved file
//
// data/matches.json keeps every match seen, keyed by day, time and players, with when it was
// first seen and whether it is still on SOOP's schedule - so a match that moves or vanishes is
// noticed, not silently replaced.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { schedule } from './sources/soop.mjs'
import { schedule as eloboardSchedule } from './sources/eloboard.mjs'
import { HANGUL, translateTitle } from './lib/terms.mjs'
import { loadNames, resolve, saveNames } from './lib/names.mjs'
import { competition } from './lib/competitions.mjs'
import { bucharest, kstInstant, kstToday } from './lib/time.mjs'

export const MATCHES_FILE = fileURLToPath(new URL('./data/matches.json', import.meta.url))

const keyOf = (m) => `${m.date} ${m.kst} ${m.a.korean} vs ${m.b.korean}`

export function loadMatches (file = MATCHES_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { updated: null, matches: [] } }
}

// The months to read: this one, and the next when it is ten days or less away.
export function monthsToRead (today) {
    const [y, m, d] = today.split('-').map(Number)
    const first = `${y}-${String(m).padStart(2, '0')}-01`
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return daysInMonth - d <= 10 ? [first, next] : [first]
}

// An EloBoard entry -> a match: a duel when its title names two players we can match, an event
// with an English title otherwise. A title still holding Korean waits for the model's
// translation (`needsTranslation`) and is shown nowhere until then.
async function fromEloboard (e, names, { lookup, today, previous }) {
    const key = `${e.date} ${e.time || 'all-day'} eloboard ${e.title}`
    let title = translateTitle(e.title)
    // Real names in a title become IDs, as everywhere else.
    for (const korean of new Set(title.match(/[\uac00-\ud7af]{2,4}/g) || [])) {
        const player = names.players[korean] || (lookup ? await resolve(names, korean, null, { lookup, today }) : null)
        if (player) title = title.replaceAll(korean, player.id)
    }
    const translated = previous?.titleSource === e.title ? previous.titleEn : null
    const titleEn = HANGUL.test(title) ? translated : title
    // Two Korean names either side of "vs", anywhere in the title ("[중계진] … 김민철 vs 김지성").
    const duel = /(?:^|\s)([\uac00-\ud7af]{2,4})\s+vs\s+([\uac00-\ud7af]{2,4})(?:\s|$)/i.exec(e.title.trim())
    const instant = e.time ? kstInstant(e.date, e.time) : kstInstant(e.date, '00:00')
    return {
        key, origin: 'eloboard', date: e.date, kst: e.time || null, allDay: !e.time, at: instant.toISOString(), bucharest: bucharest(instant),
        competition: { raw: e.title, name: titleEn || '', big: false, celebrity: false, watch: null, known: false, liquipedia: null, eloboard: true },
        titleSource: e.title, titleEn, needsTranslation: !titleEn, duel: duel ? [duel[1], duel[2]] : null,
        a: null, b: null, played: false, status: null, onSchedule: true,
        firstSeen: previous?.firstSeen, source: `https://eloboard.com/schedule?m=${e.date.slice(0, 7)}&d=${e.date}`,
    }
}

export async function refresh ({ today = kstToday(), read = schedule, names = loadNames(), lookup = true, saved = loadMatches(), now = new Date(),
    eloboard = null } = {}) {
    const seen = []
    for (const month of monthsToRead(today)) seen.push(...await read(month))
    const before = new Map(saved.matches.map((m) => [m.key, m]))
    const after = new Map()
    const changes = []
    const unknownNames = new Set()
    for (const raw of seen) {
        const key = keyOf(raw)
        const instant = kstInstant(raw.date, raw.kst)
        const side = async (s) => {
            if (s.team) return { team: s.korean }
            const player = await resolve(names, s.korean, s.race, { lookup, today })
            if (!player) unknownNames.add(s.korean)
            return { korean: s.korean, race: s.race, id: player?.id || null, nicknames: player?.nicknames || [] }
        }
        const match = {
            key, origin: 'soop', date: raw.date, kst: raw.kst, at: instant.toISOString(), bucharest: bucharest(instant),
            competition: { raw: raw.competition, ...competition(raw.competition) },
            a: await side(raw.a), b: await side(raw.b),
            played: raw.played, status: raw.status,
            firstSeen: before.get(key)?.firstSeen || now.toISOString(), onSchedule: true,
            // Results come from elsewhere (results.mjs) and survive a refresh.
            ...(before.get(key)?.result ? { result: before.get(key).result } : {}),
            source: `https://esports.sooplive.com/schedule/sc1?date=${raw.date}`,
        }
        if (!before.has(key)) changes.push({ kind: 'new', key })
        after.set(key, match)
    }
    // A future match SOOP no longer lists has moved or been cancelled: kept, marked, reported.
    const months = new Set(monthsToRead(today).map((m) => m.slice(0, 7)))
    for (const [key, old] of before) {
        if (after.has(key)) continue
        if (old.origin !== 'eloboard' && months.has(old.date.slice(0, 7)) && old.date >= today && old.onSchedule) {
            after.set(key, { ...old, onSchedule: false })
            changes.push({ kind: 'gone', key })
        } else after.set(key, old)
    }
    // EloBoard (F-238), when it was read this time; otherwise its entries stay as they were.
    // A duel SOOP also lists is SOOP's: the official schedule wins.
    const soopPairs = new Set([...after.values()].filter((m) => m.origin !== "eloboard" && m.a?.korean && m.b?.korean).map((m) => `${m.date} ${[m.a.korean, m.b.korean].sort().join(" ")}`))
    if (eloboard) {
        for (const [key, old] of after) if (old.origin === 'eloboard') after.delete(key)
        for (const e of await eloboard(today)) {
            const previous = before.get(`${e.date} ${e.time || 'all-day'} eloboard ${e.title}`)
            const match = await fromEloboard(e, names, { lookup, today, previous })
            if (match.duel && soopPairs.has(`${match.date} ${[...match.duel].sort().join(' ')}`)) continue
            match.firstSeen ||= now.toISOString()
            if (!before.has(match.key)) changes.push({ kind: 'new', key: match.key })
            after.set(match.key, match)
        }
    }
    const matches = [...after.values()].sort((x, y) => x.at.localeCompare(y.at))
    return { file: { updated: now.toISOString(), matches }, changes, names, unknownNames: [...unknownNames] }
}

export const todays = (file, today = kstToday()) => file.matches.filter((m) => m.date === today && m.onSchedule)

export function describe (m) {
    if (m.origin === 'eloboard') return `${m.date} ${m.kst || 'all day'} · ${m.titleEn || '(waiting for translation) ' + m.titleSource} [EloBoard]`
    const who = (s) => s.team ? s.team : s.id ? `${s.id} (${s.race})` : `?(${s.race})`
    return `${m.date} ${m.kst} KST / ${m.bucharest.time} ${m.bucharest.zone} · ${m.competition.name} · ${who(m.a)} vs ${who(m.b)}${m.onSchedule ? '' : ' [no longer on the schedule]'}`
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    if (process.argv.includes('--today')) {
        const t = todays(loadMatches())
        console.log(t.length ? t.map(describe).join('\n') : 'No matches today (KST).')
    } else {
        const result = await refresh({ eloboard: process.argv.includes('--no-eloboard') ? null : eloboardSchedule })
        writeFileSync(MATCHES_FILE, JSON.stringify(result.file, null, 2) + '\n')
        saveNames(result.names)
        console.log(`${result.file.matches.length} matches known; ${result.changes.length} change(s).`)
        for (const c of result.changes) console.log(`  ${c.kind}: ${describe(result.file.matches.find((m) => m.key === c.key))}`)
        if (result.unknownNames.length) console.log(`Names not matched on Liquipedia (left as ?): ${result.unknownNames.join(', ')}`)
        const t = todays(result.file)
        console.log(t.length ? `Today:\n${t.map(describe).join('\n')}` : 'No matches today (KST).')
    }
}
