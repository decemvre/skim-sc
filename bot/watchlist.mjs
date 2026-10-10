#!/usr/bin/env node
// Skim Bot: who counts as "the top ~30 players and the top teams" (Silviu, 10 Oct) - news about
// them goes to the group. bot/data/watchlist.json, kept by hand; this fills in each player's
// Korean name from their Liquipedia page so Korean news about them is recognised, and adds
// them to names.json so they are always written by ID.
//
//   node bot/watchlist.mjs     look up any player in the watchlist without a Korean name yet

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { infobox, wikitext } from './lib/liquipedia.mjs'
import { englishNicknames, loadNames, saveNames } from './lib/names.mjs'

export const WATCHLIST_FILE = fileURLToPath(new URL('./data/watchlist.json', import.meta.url))
const RACE = { terran: 'T', zerg: 'Z', protoss: 'P', random: 'R' }

export function loadWatchlist (file = WATCHLIST_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { players: [], teams: [] } }
}

export async function fill ({ list = loadWatchlist(), names = loadNames(), today = new Date().toISOString().slice(0, 10) } = {}) {
    const byId = new Map(Object.entries(names.players).map(([korean, p]) => [p.id.toLowerCase(), korean]))
    const missing = []
    for (const player of list.players) {
        const known = byId.get(player.id.toLowerCase())
        if (known) { player.korean = known; continue }
        const box = infobox(await wikitext(player.id))
        const korean = box?.name?.replace(/\(.*?\)/g, '').trim()
        if (!korean || !/[가-힯]/.test(korean)) { missing.push(player.id); continue }
        player.korean = korean
        names.players[korean] = { id: box.id || player.id, romanized: box.romanized || null, race: RACE[(box.race || '').toLowerCase()] || null,
            nicknames: englishNicknames(box.nicknames), source: `https://liquipedia.net/starcraft/${encodeURIComponent(player.id)}`, checked: today }
    }
    return { list, names, missing }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const { list, names, missing } = await fill()
    writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2) + '\n')
    saveNames(names)
    console.log(`${list.players.filter((p) => p.korean).length} of ${list.players.length} players matched; teams: ${list.teams.length}.${missing.length ? ' Not found: ' + missing.join(', ') : ''}`)
}
