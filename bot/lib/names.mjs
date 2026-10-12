// Korean names -> the IDs and nicknames we know players by. SkiM SC's rule: never a real name.
//
// names.json is the table, kept in the repository so it can be read and corrected by hand. A
// name not in it is looked up on Liquipedia once: each search hit is opened and accepted only
// if its infobox carries the same Korean name and, when we know it, the same race. Anything
// that does not check out is not guessed - it is returned as unknown, and the caller leaves
// it out or shows the race only.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { infobox, search, wikitext } from './liquipedia.mjs'

export const NAMES_FILE = fileURLToPath(new URL('../data/names.json', import.meta.url))
const RACES = { T: 'Terran', Z: 'Zerg', P: 'Protoss', R: 'Random' }

// Nicknames we can read: the Latin part of each ("철벽Iron Wall(铁壁)" -> "Iron Wall"); one
// with none (永康, 괴룡) is dropped. We know players by ID and English nickname only.
export function englishNicknames (list) {
    const out = []
    for (const raw of list || []) {
        const latin = (raw.match(/[A-Za-z][A-Za-z0-9 .'&-]*[A-Za-z0-9]/g) || []).join(' ').trim()
        if (latin.length >= 2 && !out.includes(latin)) out.push(latin)
    }
    return out
}

export function loadNames (file = NAMES_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { players: {}, unknown: {} } }
}
export function saveNames (table, file = NAMES_FILE) {
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'ko')))
    const players = Object.fromEntries(Object.entries(table.players).map(([k, v]) => [k, { ...v, nicknames: englishNicknames(v.nicknames) }]))
    writeFileSync(file, JSON.stringify({ players: sorted(players), unknown: sorted(table.unknown || {}) }, null, 2) + '\n')
}

// Does this infobox belong to the Korean name (and race) we were given?
export function matches (box, korean, race) {
    if (!box?.id) return false
    if (!box.name.replace(/\(.*?\)/g, '').trim().startsWith(korean)) return false
    if (race && RACES[race] && box.race && !box.race.toLowerCase().startsWith(RACES[race].toLowerCase())) return false
    return true
}

export async function resolve (table, korean, race, { lookup = true, today = new Date().toISOString().slice(0, 10), options } = {}) {
    const known = table.players[korean]
    if (known && (!race || !known.race || known.race === race)) return known
    if (!lookup || table.unknown?.[korean] === today) return null
    for (const title of (await search(korean, options)).slice(0, 4)) {
        const box = infobox(await wikitext(title, options))
        if (!matches(box, korean, race)) continue
        const entry = { id: box.id, romanized: box.romanized || null, race: race || Object.keys(RACES).find((k) => box.race.toLowerCase().startsWith(RACES[k].toLowerCase())) || null,
            nicknames: englishNicknames(box.nicknames).slice(0, 4), soop: box.afreeca || null, source: `https://liquipedia.net/starcraft/${encodeURIComponent(title.replace(/ /g, '_'))}`, checked: today }
        table.players[korean] = entry
        delete table.unknown?.[korean]
        return entry
    }
    // Tried today and not found: not asked again until tomorrow.
    table.unknown = { ...(table.unknown || {}), [korean]: today }
    return null
}

// A player's SOOP (ex-AfreecaTV) station, from the afreeca= field of their Liquipedia infobox:
// where they stream, and so where a match they play on their own stream is watched. Asked for
// once per player and kept in names.json ("" when they have none).
export async function station (table, id, { lookup = true, options } = {}) {
    const entry = Object.values(table.players || {}).find((p) => p.id?.toLowerCase() === String(id || '').toLowerCase())
    if (!entry) return null
    if (entry.soop === undefined && lookup && entry.source) {
        const title = decodeURIComponent(entry.source.split('/starcraft/')[1] || '')
        try { entry.soop = infobox(await wikitext(title, options))?.afreeca || '' } catch { return null }
    }
    return entry.soop ? `https://www.sooplive.com/station/${entry.soop}` : null
}
