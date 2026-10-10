#!/usr/bin/env node
// Skim Bot, F-234 (the watcher's half): new Brood War news from Korea, gathered without a model.
//
//   Naver Sports esports news - every Korean outlet, as data, one day at a time; kept only when
//     it is about Brood War (not StarCraft II, not other games' "remasters").
//   TL.net's news feed - the English-speaking scene's own Brood War news.
//
// New items go into bot/data/news-queue.json; the twice-daily model run (digest.mjs) turns the
// queue into English items for the page and the group. Seen items are remembered by id, so a
// story is queued once however often this runs.
//
//   node bot/news.mjs        check now (the watcher runs this every 30-60 minutes)

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadNames } from './lib/names.mjs'
import { inZone } from './lib/time.mjs'

export const QUEUE_FILE = fileURLToPath(new URL('./data/news-queue.json', import.meta.url))
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

// About Brood War: the game's names, its leagues - or a player we know by name.
const BROOD_WAR = /스타크래프트(?!\s*2|\s*II)|스타1|브루드\s?워|\[ASL\]|ASL\s?시즌|ASL시즌|스타리그|끝장전|스타\s?대학|KCM|빨무|스타\s?리마스터/
const NOT_BROOD_WAR = /스타크래프트\s*(2|II)|스타2|GSL|스타크래프트2/

export function aboutBroodWar (text, names = {}) {
    if (NOT_BROOD_WAR.test(text) && !/스타1|브루드/.test(text)) return false
    if (BROOD_WAR.test(text)) return true
    return Object.keys(names).some((korean) => korean.length >= 3 && text.includes(korean) && /스타|ASL|결승|승리|경기/.test(text))
}

export function loadQueue (file = QUEUE_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { seen: {}, items: [] } }
}

async function getJson (url, fetchImpl) {
    const r = await fetchImpl(url, { headers: { 'User-Agent': BROWSER }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`)
    return r.json()
}

export async function naver (day, { names = {}, fetchImpl = fetch } = {}) {
    const out = []
    for (let page = 1; page <= 5; page++) {
        const d = await getJson(`https://api-gw.sports.naver.com/news/articles/esports?sort=latest&page=${page}&pageSize=100&date=${day.replace(/-/g, '')}`, fetchImpl)
        const list = d.result?.newsList || []
        for (const n of list) {
            if (!aboutBroodWar(`${n.title} ${n.subContent || ''}`, names)) continue
            out.push({ id: `naver:${n.oid}:${n.aid}`, source: n.sourceName || 'Naver', lang: 'ko', title: n.title, summary: (n.subContent || '').slice(0, 600),
                link: `https://m.sports.naver.com/esports/article/${n.oid}/${n.aid}`, at: n.dateTime })
        }
        if (list.length < 100) break
    }
    return out
}

export async function teamliquid ({ fetchImpl = fetch } = {}) {
    const r = await fetchImpl('https://tl.net/rss/news.xml', { headers: { 'User-Agent': BROWSER }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`tl.net answered ${r.status}`)
    const xml = await r.text()
    const items = []
    for (const block of xml.split('<item>').slice(1)) {
        const tag = (name) => (new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(block)?.[1] || '').trim()
        const title = tag('title'), link = tag('link'), category = tag('category')
        // TL.net's feed mixes games; Brood War items say so in the category or the title.
        if (!/brood ?war|\bBW\b|ASL|KCM|Remastered/i.test(`${title} ${category}`)) continue
        items.push({ id: `tl:${link}`, source: 'TL.net', lang: 'en', title, summary: tag('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600),
            link, at: tag('pubDate') ? new Date(tag('pubDate')).toISOString() : null })
    }
    return items
}

// One watcher pass: today's and yesterday's Korean news, and TL.net. Returns what was new.
export async function check ({ now = new Date(), queue = loadQueue(), names = loadNames().players, sources = { naver, teamliquid } } = {}) {
    const today = inZone(now, 'Asia/Seoul').date
    const yesterday = inZone(new Date(now - 86400000), 'Asia/Seoul').date
    const found = []
    const errors = []
    for (const [name, run] of [['naver', () => Promise.all([sources.naver(today, { names }), sources.naver(yesterday, { names })]).then((a) => a.flat())], ['tl', () => sources.teamliquid()]]) {
        try { found.push(...await run()) } catch (error) { errors.push(`${name}: ${error.message}`) }
    }
    // Today's and yesterday's lists overlap: one story, one entry.
    const unique = [...new Map(found.map((item) => [item.id, item])).values()]
    const fresh = unique.filter((item) => !queue.seen[item.id])
    for (const item of fresh) { queue.seen[item.id] = now.toISOString(); queue.items.push({ ...item, queuedAt: now.toISOString(), done: false }) }
    // Forget what was seen more than three weeks ago; Naver is only asked for two days anyway.
    for (const [id, at] of Object.entries(queue.seen)) if (now - Date.parse(at) > 21 * 86400000) delete queue.seen[id]
    queue.items = queue.items.filter((i) => !i.done || now - Date.parse(i.queuedAt) < 7 * 86400000)
    return { queue, fresh, errors }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const { queue, fresh, errors } = await check()
    writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n')
    console.log(`${fresh.length} new item(s); ${queue.items.filter((i) => !i.done).length} waiting for the model run.`)
    for (const i of fresh) console.log(`  [${i.source}] ${i.title}`)
    if (errors.length) console.log(`Problems: ${errors.join('; ')}`)
}
