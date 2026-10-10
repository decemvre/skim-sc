#!/usr/bin/env node
// Skim Bot, F-234 (the model's half): the queued news, turned into short English items.
//
// This is one of the two model runs a day (morning and evening, O-98), and only when the
// watcher has queued something. Claude runs it (`claude -p`, no tools, a fixed JSON shape);
// Grok (`grok -p`) is asked instead if Claude's run fails.
//
// Silviu's two rules are enforced here in code, not left to the prompt:
//   - Never a real name. The model writes {{name:<Korean name>}} wherever a Korean player is
//     mentioned; the code puts the player's ID there (names.json, Liquipedia), or "a player"
//     when nobody can be matched. An item that still holds Hangul, or a romanized real name
//     from the table, is dropped.
//   - No spoilers in the group. Each item says whether it reveals a result, and carries a
//     separate one-line `card` that must not; spoiler items' text is shown on the page only
//     behind a closed dropdown.

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadQueue, QUEUE_FILE } from './news.mjs'
import { loadNames, resolve, saveNames } from './lib/names.mjs'

export const NEWS_FILE = fileURLToPath(new URL('./data/news.json', import.meta.url))
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/

export const SCHEMA = {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: { items: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['headline', 'summary', 'spoiler', 'card', 'sources', 'date'],
        properties: {
            headline: { type: 'string' }, summary: { type: 'string' }, spoiler: { type: 'boolean' },
            card: { type: ['string', 'null'] }, sources: { type: 'array', items: { type: 'string' } }, date: { type: 'string' },
        },
    } } },
}

export function prompt (items) {
    return `You write short English news items about Korean StarCraft: Brood War for a group of friends in Romania who follow the Korean scene but do not read Korean.

Below are news items gathered today (Korean and English). Turn them into English items.

Rules - all of them matter:
1. Several items about the same story become ONE item, with all their links in "sources".
2. NEVER write a person's real name, in Korean or romanized (no "Yoo Young-jin", no "유영진"). Wherever the source names a Korean player by real name, write {{name:<that Korean name exactly as written in the source>}} - for example {{name:유영진}} - even if you know the player's ID; the program fills in the ID. A player an English source already calls by ID (Rush, Soulkey, Flash) is written by that ID. Teams, leagues and broadcasters by their usual English names; translate Korean team names when the meaning is plain.
3. "headline": at most 80 characters. "summary": two or three plain sentences. "date": YYYY-MM-DD of the story.
4. "spoiler": true if the item reveals any match result - a winner, a score, who advanced or was knocked out, who is in a final because of a win.
5. "card": one line of at most 100 characters for the group chat that reveals NO result at all, even if the item is a spoiler (e.g. "Interviews with both ASL S22 finalists ahead of Saturday's final" is fine; "Rush beats Light 4-2" is not). Use null if the story cannot be told without a result.
6. Leave out anything not about Brood War (StarCraft II, other games), adverts, and items with nothing new.
7. Answer with JSON only, in the given shape. No commentary.

Items:
${JSON.stringify(items.map((i) => ({ source: i.source, lang: i.lang, title: i.title, summary: i.summary, link: i.link, at: i.at })), null, 1)}`
}

function run (cmd, args, input, timeout = 300000) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`${cmd}: ${(stderr || error.message).trim().split('\n').slice(-2).join(' ')}`))
            resolve(stdout)
        })
        child.stdin.end(input)
    })
}

// The first JSON object in a model's answer.
export function firstJson (text) {
    const start = text.indexOf('{')
    if (start < 0) throw new Error('no JSON in the answer')
    let depth = 0, inString = false, escaped = false
    for (let i = start; i < text.length; i++) {
        const c = text[i]
        if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue }
        if (c === '"') inString = true
        else if (c === '{') depth++
        else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
    throw new Error('unfinished JSON in the answer')
}

export const RUNNERS = {
    async claude (text) {
        const out = await run('claude', ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--tools', '', '--strict-mcp-config'], text)
        const envelope = JSON.parse(out)
        if (envelope.is_error) throw new Error(`claude: ${envelope.result || 'error'}`)
        return envelope.structured_output || firstJson(String(envelope.result || ''))
    },
    async grok (text) {
        return firstJson(await run('grok', ['-p', `${text}\n\nThe JSON shape: ${JSON.stringify(SCHEMA)}`, '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write'], ''))
    },
}

// {{name:유영진}} -> Rush, or "a player". Returns null for an item that cannot be made safe.
export async function cleanItem (item, names, { lookup = true, resolveName = resolve } = {}) {
    const fill = async (text) => {
        let out = String(text ?? '')
        for (const [, korean] of out.matchAll(/\{\{name:([^}]+)\}\}/g)) {
            const player = await resolveName(names, korean.trim(), null, { lookup })
            out = out.replaceAll(`{{name:${korean}}}`, player?.id || 'a player')
        }
        return out.replace(/\s+/g, ' ').trim()
    }
    const clean = { ...item, headline: await fill(item.headline), summary: await fill(item.summary), card: item.card ? await fill(item.card) : null }
    const text = `${clean.headline} ${clean.summary} ${clean.card || ''}`
    if (HANGUL.test(text) || /\{\{name:/.test(text)) return null
    const romanized = Object.values(names.players || {}).map((p) => p.romanized).filter((r) => r && r.length > 4)
    if (romanized.some((r) => text.toLowerCase().includes(r.toLowerCase()))) return null
    if (clean.card && clean.card.length > 140) clean.card = clean.card.slice(0, 137) + '…'
    return clean
}

export function loadNews (file = NEWS_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { items: [] } }
}

export async function digest ({ queue = loadQueue(), names = loadNames(), news = loadNews(), runners = RUNNERS, order = ['claude', 'grok'], now = new Date(), lookup = true } = {}) {
    const waiting = queue.items.filter((i) => !i.done).slice(0, 40)
    if (!waiting.length) return { ran: false, added: [], queue, news, names }
    let answer = null, by = null
    const failures = []
    for (const name of order) {
        try { answer = await runners[name](prompt(waiting)); by = name; break } catch (error) { failures.push(error.message) }
    }
    if (!answer) throw new Error(`no model could digest the news: ${failures.join(' | ')}`)
    const added = []
    let dropped = 0
    for (const raw of answer.items || []) {
        const item = await cleanItem(raw, names, { lookup })
        if (!item) { dropped++; continue }
        added.push({ ...item, id: `${item.date}:${item.headline}`.slice(0, 120), addedAt: now.toISOString(), by, posted: false })
    }
    for (const i of waiting) i.done = true
    const known = new Set(news.items.map((i) => i.id))
    news.items = [...added.filter((i) => !known.has(i.id)), ...news.items].filter((i) => now - Date.parse(i.addedAt) < 60 * 86400000)
    return { ran: true, by, added, dropped, failures, queue, news, names }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const result = await digest()
    if (!result.ran) { console.log('Nothing queued: no model run.'); process.exit(0) }
    writeFileSync(NEWS_FILE, JSON.stringify(result.news, null, 2) + '\n')
    writeFileSync(QUEUE_FILE, JSON.stringify(result.queue, null, 2) + '\n')
    saveNames(result.names)
    console.log(`${result.by} wrote ${result.added.length} item(s)${result.dropped ? `; ${result.dropped} dropped for a real name left in` : ''}${result.failures.length ? ` (after: ${result.failures.join('; ')})` : ''}.`)
    for (const i of result.added) console.log(`  ${i.spoiler ? '[spoiler] ' : ''}${i.headline}\n    card: ${i.card ?? '(none - cannot be told without a result)'}`)
}
