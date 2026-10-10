// EloBoard (eloboard.com), F-238: the star-university scene's schedule and its daily news -
// university clashes, CK, mini-matches, cups - which SOOP's official schedule does not carry.
// The site turns plain requests away, so it is read with Chrome headless like SOOP.
//
// Schedule: the month grid shows three entries a day, so the coming week's full days are
// opened one by one. Most entries are streamers' broadcasts (camping, futsal, talent shows);
// only matches are kept. News: /news/<date>, one <article> per story.

import { createHash } from 'node:crypto'

import { dumpPage, textLines } from './soop.mjs'

export const SITE = 'https://eloboard.com'

const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')

// A match, not a broadcast: two sides, or a competition word - and not another game or a
// streamer's day out.
const MATCH = /\bvs\b|대전|끝장전|ck|컵|리그|대회|최강자전|결승|매치/i
const NOT_A_MATCH = /캠핑|글램핑|장기자랑|풋살|코스프레|노답회의|힐링|오디션|여행|먹방|서든|발로|롤\b|배그|오버워치|피파|축구|노래|생일|회식/
export const isMatch = (title) => MATCH.test(title) && !NOT_A_MATCH.test(title)

// The month grid: { date, time, title }[] and which days were cut short.
export function parseMonth (html) {
    const out = [], full = []
    for (const [, date, cell] of html.matchAll(/<a[^>]*href="\/schedule\?[^"]*?d=(\d{4}-\d{2}-\d{2})[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
        const entries = [...cell.matchAll(/__entry[^"]*">(?:<i[^>]*><\/i>)?(?:<em>([^<]*)<\/em>)?<span>([^<]*)<\/span>/g)]
        for (const [, time, title] of entries) out.push({ date, time: time || null, title: unesc(title).trim() })
        if (entries.length >= 3) full.push(date)
    }
    return { entries: out, full }
}

// One day's page: the list under "10월 10일 (토)7건" - a time line, then the title (sometimes
// after a short tag line), until the next time.
export function parseDay (html, date) {
    const lines = textLines(html)
    // "10월 10일 (토)", then "7" and "건" on lines of their own.
    const start = lines.findIndex((l) => /^\d{1,2}월 \d{1,2}일 \(.\)/.test(l))
    if (start < 0) return []
    const out = []
    let current = null
    for (const line of lines.slice(start + 1)) {
        if (/^(개인정보처리방침|이용약관|후원하기)$/.test(line)) break
        if (/^\d{1,2}:\d{2}$/.test(line)) { current = { date, time: line.padStart(5, '0'), title: '' }; out.push(current); continue }
        if (!current || /^(LIVE|방송 중|\d+|건)$/.test(line) || /^방송 보기|^·\s*[\d,]+명$/.test(line)) continue
        // A title is one line, or a short tag line ("CK", "미니대전") and one line; anything
        // after that is the page's ads.
        if (!current.title) current.title = line
        else if (!current.tagged && current.title.length <= 6) { current.title = `${current.title} ${line}`; current.tagged = true }
    }
    return out
}

export async function schedule (today, { daysAhead = 8, dump = dumpPage } = {}) {
    const month = today.slice(0, 7)
    const { entries, full } = parseMonth(await dump(`${SITE}/schedule?m=${month}&k=match`))
    const until = new Date(Date.parse(`${today}T00:00:00Z`) + daysAhead * 86400000).toISOString().slice(0, 10)
    const byDay = new Map()
    for (const e of entries) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e) }
    for (const date of full.filter((d) => d >= today && d <= until)) {
        const day = parseDay(await dump(`${SITE}/schedule?m=${month}&d=${date}&k=match`), date)
        if (day.length) byDay.set(date, [...day.map(({ tagged, ...e }) => e), ...byDay.get(date).filter((e) => !e.time)])
    }
    return [...byDay.values()].flat().filter((e) => isMatch(e.title))
}

// /news/<date>: each <article> -> a queue item.
export function parseNews (html, date) {
    const items = []
    for (const [, article] of html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/g)) {
        const headline = unesc((/<h[24][^>]*>([\s\S]*?)<\/h[24]>/.exec(article)?.[1] || '').replace(/<[^>]+>/g, '')).trim()
        if (!headline) continue
        const paragraphs = [...article.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => unesc(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter((p) => p.length > 20)
        const post = /href="(\/community\/posts\/\d+)"/.exec(article)?.[1]
        items.push({ id: `eloboard:${date}:${createHash('sha1').update(headline).digest('hex').slice(0, 10)}`, source: 'EloBoard', lang: 'ko',
            title: headline, summary: paragraphs.join(' ').slice(0, 700), link: post ? `${SITE}${post}` : `${SITE}/news/${date}`, at: `${date}T12:00:00` })
    }
    return items
}

export async function news (date, { dump = dumpPage } = {}) {
    return parseNews(await dump(`${SITE}/news/${date}`), date)
}
