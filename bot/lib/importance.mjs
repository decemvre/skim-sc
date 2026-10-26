// Skim Bot: which matches matter most, for /skim answers (Silviu, 26 Oct 2026).
//
// A 1v1 between two players on the watchlist (bot/data/watchlist.json, the top ~30 the bot
// tracks) is a top-level match and ranks ABOVE everything else, league games included - a
// showmatch between two of them is never "less important because it is a showmatch". Asked
// "any important showmatches today?" the bot named Dreamz vs JSA and left Soulkey vs Rush out.
// Then the big competitions (lib/competitions.mjs), then the rest.
//
// The start of a match is said as its Bucharest time and how long until it, worked out here
// rather than by the model ("starts in about 4.5 hours from now (16:25 KST)" mixed the two).

import { bucharest, kstInstant } from './time.mjs'

export const topIds = (watchlist) => new Set((watchlist.players || []).map((p) => String(p.id).toLowerCase()))

const side = (s) => s && !s.team && s.id ? String(s.id).toLowerCase() : null
// Both sides of a 1v1 checked against the watchlist.
export function topMatch (m, top) {
    const a = side(m.a), b = side(m.b)
    return Boolean(a && b && a !== b && top.has(a) && top.has(b))
}

export const rank = (m, top) => topMatch(m, top) ? 0 : m.competition?.big ? 1 : 2

export const startOf = (m) => Date.parse(m.at || '') || (m.date && m.kst ? kstInstant(m.date, m.kst).getTime() : NaN)

// "14:00 Bucharest, in 4 h 35 min" / "in 40 min" / "started 20 min ago".
export function startsLine (m, now = new Date()) {
    const at = startOf(m)
    if (!Number.isFinite(at)) return m.date ? `${m.date}, time not known` : 'time not known'
    const time = bucharest(new Date(at)).time
    const min = Math.round((at - now) / 60000)
    const span = (x) => x >= 60 ? `${Math.floor(x / 60)} h${x % 60 ? ` ${x % 60} min` : ''}` : `${x} min`
    return `${time} Bucharest, ${min >= 0 ? `in ${span(min)}` : `started ${span(-min)} ago`}`
}

// The next `hours` of the schedule, most important first, then by start.
export function upcoming (matches, { watchlist, now = new Date(), hours = 24, limit = 12 } = {}) {
    const top = topIds(watchlist)
    return matches
        .filter((m) => !m.competition?.celebrity && Number.isFinite(startOf(m)) && startOf(m) - now > -3 * 3600e3 && startOf(m) - now <= hours * 3600e3)
        .sort((x, y) => rank(x, top) - rank(y, top) || startOf(x) - startOf(y))
        .slice(0, limit)
        .map((m) => ({ m, rank: rank(m, top) }))
}

export function upcomingLines (matches, options = {}) {
    const now = options.now || new Date()
    return upcoming(matches, options).map(({ m, rank: r }) => {
        const who = m.a?.id && m.b?.id ? `${m.a.id} (${m.a.race || '?'}) vs ${m.b.id} (${m.b.race || '?'})` : (m.titleEn || m.competition?.name || m.competition?.raw || 'match')
        const tag = r === 0 ? 'TOP-LEVEL 1v1 - both are top players the bot tracks; MORE important than any league game' : r === 1 ? 'big competition' : 'minor'
        const event = m.a?.id && m.b?.id ? `, ${m.competition?.name || m.competition?.raw || ''}` : ''
        return `- [${tag}] ${who}${event}: starts ${startsLine(m, now)}${m.competition?.watch ? `, watch: ${m.competition.watch}` : ''}`
    })
}
