// Skim Bot: results, for the page only and only behind the spoiler dropdown (Silviu, 10 Oct).
// SOOP hides scores, so they come from Liquipedia's tournament pages, where each match is a
// {{Match}} with its date and the winner of every map. A result is matched to our match by
// day and both player IDs, and is the count of maps each won.

import { wikitext } from './lib/liquipedia.mjs'

// Every {{Match ...}} in a page, with braces balanced.
export function matchBlocks (text) {
    const blocks = []
    let i = 0
    while ((i = text.indexOf('{{Match', i)) >= 0) {
        let depth = 0, j = i
        for (; j < text.length; j++) {
            if (text.startsWith('{{', j)) { depth++; j++ } else if (text.startsWith('}}', j)) { depth--; j++; if (!depth) break }
        }
        blocks.push(text.slice(i, j + 1))
        i = j + 1
    }
    return blocks
}

export function parseMatch (block) {
    const date = /\|date=(\d{4}-\d{2}-\d{2})/.exec(block)?.[1] || null
    const opponents = [...block.matchAll(/\|opponent[12]=\{\{1Opponent\|([^|}]+)/g)].map((m) => m[1].trim())
    const winners = [...block.matchAll(/\{\{Map\|[^}]*winner=([12])/g)].map((m) => Number(m[1]))
    if (opponents.length !== 2 || !winners.length) return null
    return { date, players: opponents, score: [winners.filter((w) => w === 1).length, winners.filter((w) => w === 2).length] }
}

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()

// Fill in results for played matches we can tie to a Liquipedia page. Pages are read once each.
export async function addResults (matches, { read = wikitext } = {}) {
    const pages = new Map()
    let found = 0
    for (const m of matches) {
        if (!m.played || m.result || !m.competition.liquipedia || !m.a.id || !m.b.id) continue
        if (!pages.has(m.competition.liquipedia)) pages.set(m.competition.liquipedia, (matchBlocks(await read(m.competition.liquipedia) || '')).map(parseMatch).filter(Boolean))
        const hit = pages.get(m.competition.liquipedia).find((r) => r.date === m.date &&
            ((same(r.players[0], m.a.id) && same(r.players[1], m.b.id)) || (same(r.players[0], m.b.id) && same(r.players[1], m.a.id))))
        if (!hit) continue
        const flipped = same(hit.players[0], m.b.id)
        m.result = { a: flipped ? hit.score[1] : hit.score[0], b: flipped ? hit.score[0] : hit.score[1],
            source: `https://liquipedia.net/starcraft/${m.competition.liquipedia}` }
        found++
    }
    return found
}
