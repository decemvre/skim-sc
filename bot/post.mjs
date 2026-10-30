#!/usr/bin/env node
// Skim Bot, F-236: what goes to the group chat, through the Friendzy WhatsApp bridge.
// Silviu's rules (10 Oct), all of them enforced here:
//
//   - NOTHING is posted outside 08:00-16:00 Bucharest time (this machine's time). send()
//     refuses, whatever called it.
//   - morning   one post with the day's highlights: today's matches (KST) and the news that
//               came in since the last post. On a weekend: only major matches, no news.
//   - news      relevant news (12 Oct: only a top-30 watchlist player, the ASL, Race Wars or the
//               Major Proleague - lib/scope.mjs) as soon as it
//               is ready - weekdays, inside the window. Later news waits for the next weekday
//               morning's post. Never news on a weekend.
//   - reminder  30 minutes before a major match, any day - if that moment is inside the window.
//
//   - results   the result of a match between star-university teams, once known (12 Oct): in
//               the morning post, with the news during the week, on its own at a weekend.
//               The only result ever posted unasked (Silviu, 17 Oct); /skim gives others
//               only when a question asks for one (bot/ask.mjs).
//
// Korean StarCraft: Brood War only (Silviu, 17 Oct): /skim answers about StarCraft anywhere and
// about Korea, but what the bot posts unasked stays Korean Brood War (lib/scope.mjs).
//
// Nothing on a quiet day. Never any other result: the text is built only from the schedule,
// the news items' spoiler-free cards and the university results, and a last check drops any
// other line that looks like a score.
// English, links alone on their own line. The bridge reads nothing in the group but /skim
// questions (F-287, bot/ask.mjs), which are answered at any hour.
//
// Which group: ~/.config/friendzy/skim-bot.json {"group": "<exact WhatsApp name>"}, and the
// same name in the bridge's "groups". Until both are set, a post is printed, not sent.

import { readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadMatches } from './matches.mjs'
import { loadNews } from './digest.mjs'
import { inScope } from './lib/scope.mjs'
import { loadWatchlist } from './watchlist.mjs'
import { major, topIds, topMatch } from './lib/importance.mjs'
import { bucharest, kstInstant, kstToday } from './lib/time.mjs'

export const SITE = 'https://decemvre.github.io/skim-sc/'
export const CONFIG_FILE = join(homedir(), '.config/friendzy/skim-bot.json')
export const POSTED_FILE = fileURLToPath(new URL('./data/posted.json', import.meta.url))
export const BRIDGE = process.env.FRIENDZY_WHATSAPP_BRIDGE || 'http://127.0.0.1:8796'
export const REMIND_MIN = 30
// A post (morning or news) names at most this many stories; the rest are on the page (12 Oct: a
// Monday carrying the weekend's six was too long, and WhatsApp folded it).
export const MORNING_NEWS = 3
// Typing a long post takes the bridge minutes: the morning one of 12 Oct took over five, and
// fetch() gives up on an answer after five whatever the signal says.
export const SEND_TIMEOUT_MS = 15 * 60000
export const WINDOW = { from: 8 * 60, to: 16 * 60, zone: 'Europe/Bucharest' }
// The bridge refuses a message over 700 characters (WhatsApp folds one behind "Read more" at 768;
// 26 Oct: a 757-character morning post was refused and nothing went). A longer post goes as parts.
export const POST_MAX = 700

export function local (now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: WINDOW.zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(now).map((p) => [p.type, p.value]))
    return { minutes: Number(parts.hour) * 60 + Number(parts.minute), weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' }
}
export const inWindow = (now = new Date()) => { const t = local(now).minutes; return t >= WINDOW.from && t < WINDOW.to }

const SCORE = /\b\d{1,2}\s*[-–:]\s*\d{1,2}\b|\b(beats?|beat|defeats?|defeated|wins?|won|eliminat\w*|knocks? out|knocked out|advances?|advanced)\b/i

export function loadPosted (file = POSTED_FILE) {
    try { return { mornings: {}, reminders: {}, news: {}, results: {}, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { return { mornings: {}, reminders: {}, news: {}, results: {} } }
}
export function config (file = CONFIG_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

const who = (s) => s.team ? null : `${s.id || '?'} (${s.race})`
const dayName = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

// The lines for one match: "ASL S22: Rush (T) vs Soulkey (Z)" / "15:00 KST · 09:00 Bucharest".
function matchLines (m) {
    if (m.origin === 'eloboard') return m.titleEn ? [m.titleEn, m.kst ? `${m.kst} KST · ${m.bucharest.time} Bucharest` : 'All day'] : null
    const players = who(m.a) && who(m.b) ? `${who(m.a)} vs ${who(m.b)}` : null
    if (!players) return null
    return [`${m.competition.name.replace(/\bSeason\s+(\d+)/i, 'S$1')}: ${players}`, `${m.kst} KST · ${m.bucharest.time} Bucharest`]
}

// News worth a line: relevant, in scope (lib/scope.mjs), a spoiler-free card, not posted, added
// in the last five days (a Monday morning carries the weekend's), newest first, at most six.
export function freshCards (news, posted, now = new Date(), watchlist = loadWatchlist()) {
    return (news.items || []).filter((i) => i.relevant !== false && inScope(i, watchlist) && !i.teamResult && i.card && !SCORE.test(i.card) && !posted.news[i.id] &&
        !(i.sources || []).some((s) => /tl\.net|teamliquid/i.test(s)) && now - Date.parse(i.addedAt || 0) < 5 * 86400000).slice(0, 6)
}

// University team results not posted yet (Silviu, 12 Oct), from the last two days, oldest first.
export function freshResults (news, posted, now = new Date()) {
    return (news.items || []).filter((i) => i.teamResult && !(posted.results || {})[i.id] && now - Date.parse(i.addedAt || 0) < 2 * 86400000)
        .sort((x, y) => String(x.date).localeCompare(String(y.date)))
}
const resultLines = (results) => results.map((r) => r.teamResult)

// The line under a title (Silviu, 10 Oct): the first sentence of the spoiler-free teaser; for a
// story with no result in it, its summary's. Nothing when that would give a result away.
const firstSentence = (text) => (String(text || '').match(/^.*?[.!?](\s|$)/)?.[0] || String(text || '')).trim()
export function blurb (item) {
    const text = item.teaser ? firstSentence(item.teaser) : item.spoiler ? '' : firstSentence(item.summary)
    return text && !SCORE.test(text) ? text : ''
}
// A match still to come (Silviu, 12 Oct): "Tue 13 Oct · 21:00 KST · 15:00 Bucharest", or the day alone.
export function whenLine (match) {
    if (!match?.date) return ''
    if (!match.time) return dayName(match.date)
    return `${dayName(match.date)} · ${match.time} KST · ${bucharest(kstInstant(match.date, match.time)).time} Bucharest`
}
// One news item in the chat: its title in bold, the short summary below it, and for a match its
// time and - alone on its own line - where to watch it.
export const newsBlock = (c) => [[`*${c.card}*`, blurb(c), whenLine(c.match)].filter(Boolean).join('\n'), c.match?.link].filter(Boolean).join('\n\n')

export function morningText (matches, cards, today, { weekend = false, results = [], watchlist = loadWatchlist() } = {}) {
    // Major = a big competition or a 1v1 between two watchlist players (Silviu, 26 Oct); those
    // 1v1s first, as the most important of the day, the rest in schedule order.
    const top = topIds(watchlist)
    const todays = matches.filter((m) => m.date === today && m.onSchedule && !m.competition.celebrity && (!weekend || major(m, top)))
        .map((m, i) => ({ m, i, lines: matchLines(m) })).filter((x) => x.lines)
        .sort((x, y) => Number(topMatch(y.m, top)) - Number(topMatch(x.m, top)) || x.i - y.i)
    const news = weekend ? [] : cards
    if (!todays.length && !news.length && !results.length) return null
    const parts = [`🤖 Skim Bot - ${todays.length ? `Brood War in Korea today (${dayName(today)})` : `Brood War news (${dayName(today)})`}`]
    for (const { lines } of todays) parts.push(lines.join('\n'))
    const watch = [...new Set(todays.map(({ m }) => m.competition.watch).filter(Boolean))]
    if (watch.length) parts.push('Watch live:', ...watch)
    if (results.length) parts.push('University results:', resultLines(results).join('\n'))
    if (news.length) parts.push(...(todays.length || results.length ? ['News:'] : []), ...news.slice(0, MORNING_NEWS).map(newsBlock))
    parts.push('More on the page:', SITE)
    return parts.join('\n\n')
}

export function newsText (cards, results = []) {
    if (!cards.length && !results.length) return null
    const head = cards.length ? '🤖 Skim Bot - Brood War news' : '🤖 Skim Bot - University results'
    return [head, ...(results.length ? [...(cards.length ? ['University results:'] : []), resultLines(results).join('\n')] : []),
        ...(results.length && cards.length ? ['News:'] : []), ...cards.slice(0, MORNING_NEWS).map(newsBlock), 'More on the page:', `${SITE}#news`].join('\n\n')
}

export function reminderText (m, now = new Date()) {
    const lines = matchLines(m)
    if (!lines) return null
    const minutes = Math.max(1, Math.round((Date.parse(m.at) - now) / 60000))
    return [`🤖 Starting in ${minutes} minutes`, lines.join('\n'), ...(m.competition.watch ? ['Watch live:', m.competition.watch] : [])].join('\n\n')
}

// Matches starting within REMIND_MIN, not yet reminded. Within it, not within it plus the timer's
// 15 minutes: with that slack the :15 run caught every match on the hour, and reminders went out
// 45 minutes before (Silviu, 17 Oct). The run every 15 minutes still lands one inside the 30.
export function dueReminders (matches, posted, now = new Date(), watchlist = loadWatchlist()) {
    const top = topIds(watchlist)
    return matches.filter((m) => major(m, top) && m.onSchedule && !m.played && !posted.reminders[m.key] &&
        Date.parse(m.at) - now > 0 && Date.parse(m.at) - now <= REMIND_MIN * 60000)
}

// The last line of defence: nothing that looks like a result leaves this machine, but for the
// university results the post was built with (`allowed`, line for line).
export function safe (text, allowed = []) {
    return text.split('\n').filter((line) => allowed.includes(line) || !(SCORE.test(line) && !/KST|Bucharest|https?:\/\//.test(line))).join('\n')
}

// A post in parts of at most `max` characters, as the bridge counts them (26 Oct). Split between
// paragraphs, packed as full as they go; a paragraph ending in ":" stays with the one after it, so
// "More on the page:" never leaves its link behind. A paragraph too long alone is split between
// its lines, and a line too long alone is cut at a word, with "…" - nothing is left out silently
// except the end of that one line.
export function splitPost (text, max = POST_MAX) {
    const cut = (line) => line.length <= max ? line : `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…`
    const fit = (pieces, sep) => {
        const out = []
        for (const piece of pieces) {
            const last = out.at(-1)
            if (last !== undefined && last.length + sep.length + piece.length <= max) out[out.length - 1] = `${last}${sep}${piece}`
            else out.push(piece)
        }
        return out
    }
    const paragraphs = String(text).trim().split(/\n{2,}/)
    const blocks = []
    for (const p of paragraphs) {
        const prev = blocks.at(-1)
        if (prev !== undefined && /:$/.test(prev)) blocks[blocks.length - 1] = `${prev}\n\n${p}`
        else blocks.push(p)
    }
    const pieces = blocks.flatMap((b) => b.length <= max ? [b] : fit(b.split('\n').map(cut), '\n'))
    return fit(pieces, '\n\n')
}

// WhatsApp's message box turns a line typed as "• ", "- " or "* " into a list item, and inside a
// list Enter adds the next item instead of sending (B-355, 28 and 30 Oct: "/skim help" stopped
// after its first part, every time, at the part whose lines start with "•"). Such a line goes with
// "▸ ", which the box leaves alone. "*bold*" has no space after its mark and is not touched.
export const LIST_MARK = /^([ \t]*)[•*+-][ \t]+/gm
export const unlisted = (text) => String(text).replace(LIST_MARK, '$1▸ ')

// A post that may or may not be in the group: the bridge's answer never came, or it typed the
// post and could not see it go. Recorded as posted, so the next pass does not post it again
// (12 Oct: three copies of one morning post), and said in the war room.
export class UnsureError extends Error {}
const UNSURE_CODES = ['unconfirmed', 'no-tick']

// fetch() without its five-minute limit on the answer: node:http waits as long as `signal` says.
export function patientFetch (url, { method = 'GET', headers, body, signal } = {}) {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, { method, headers, signal }, (response) => {
            const chunks = []
            response.on('data', (c) => chunks.push(c))
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(text) })
            })
            response.on('error', reject)
        })
        request.on('error', reject)
        if (body) request.write(body)
        request.end()
    })
}

export async function send (text, { group = config().group, fetchImpl = patientFetch, dryRun = false, now = new Date(), allowed = [], asked = false,
    video = false, override = null } = {}) {
    // 08:00-16:00 Bucharest for everything the bot says by itself. An answer to somebody's
    // /skim question (F-287) is not the bot speaking up: it goes whenever it was asked, and
    // says what was asked for - a result included, when that is the question.
    // The reply to a YouTube link somebody posted (F-535) goes at any hour too (Silviu, 26 Oct),
    // as it is: a video's title is not checked for scores.
    // `override` is a one-off exception Silviu gave for a single post, with its reason - never
    // for anything automatic; the post is still checked for results.
    if (override !== null && !String(override).trim()) throw new Error('an override needs its reason')
    if (!asked && !video && !override && !inWindow(now)) throw new Error('outside 08:00-16:00 Bucharest: nothing is posted to the group')
    if (override) console.error(`send: outside the window by Silviu's exception - ${override}`)
    const body = unlisted(asked || video ? text : safe(text, allowed))
    const parts = splitPost(body)
    if (!group || dryRun) return { sent: false, printed: parts.join('\n\n--- next message ---\n\n'), parts: parts.length, why: group ? 'dry run' : `no group set in ${CONFIG_FILE}` }
    let status
    for (const [i, part] of parts.entries()) {
        // Once a part is in the group the post is there in part: a later failure is recorded as
        // posted (UnsureError), or the next pass would post the first parts again.
        const of = parts.length > 1 ? ` (part ${i + 1} of ${parts.length}${i ? `; parts 1-${i} are in the group` : ''})` : ''
        const failed = (message) => i ? new UnsureError(`${message}${of}: recorded as posted, look at the group`) : new Error(`${message}${of}`)
        let r
        try {
            r = await fetchImpl(`${BRIDGE}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Friendzy-Office': '1' },
                body: JSON.stringify({ group, agent: 'skim', text: part }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
        } catch (error) {
            // Refused before it was sent, the request never left; anything else may have been typed.
            if (error.code === 'ECONNREFUSED') throw failed('the bridge is not running: nothing more was posted')
            throw new UnsureError(`no answer from the bridge (${error.name === 'TimeoutError' ? 'timed out' : error.message})${of}: the post may be in the group - recorded as posted, look at the group`)
        }
        const data = await r.json().catch(() => ({}))
        if (UNSURE_CODES.includes(data.code)) throw new UnsureError(`the bridge typed the post but could not see it go (${data.code})${of}: recorded as posted, look at the group`)
        if (!r.ok || !data.sent) throw failed(`the bridge did not post: ${data.error || r.status}`)
        status = data.status
    }
    return parts.length > 1 ? { sent: true, status, parts: parts.length } : { sent: true, status }
}

export async function post (kind, { now = new Date(), posted = loadPosted(), matches = loadMatches().matches, news = loadNews(), dryRun = false, sender = send } = {}) {
    const today = kstToday(now)
    const results = []
    // Outside the window nothing happens at all - not even a reminder that would be late.
    if (!inWindow(now)) return { results, posted }
    const { weekend } = local(now)
    posted.results ||= {}
    const told = (results) => { for (const r of results) posted.results[r.id] = now.toISOString() }
    const deliver = async (text, after, allowed = []) => {
        let r
        try {
            r = await sender(text, { dryRun, now, allowed })
        } catch (error) {
            if (error instanceof UnsureError) after()
            throw error
        }
        results.push(r)
        if (r.sent || dryRun) after()
    }
    if (kind === 'morning' && !posted.mornings[today]) {
        const cards = weekend ? [] : freshCards(news, posted, now)
        const results = freshResults(news, posted, now)
        const text = morningText(matches, cards, today, { weekend, results })
        // Every fresh story counts as told, those past MORNING_NEWS too: they are on the page.
        if (text) await deliver(text, () => { posted.mornings[today] = now.toISOString(); for (const c of cards) posted.news[c.id] = now.toISOString(); told(results) }, resultLines(results))
        // A quiet morning is still a morning: news may follow during the day.
        else posted.mornings[today] = `nothing (${now.toISOString()})`
    }
    // During the week news and university results go together; at a weekend, results alone.
    if (kind === 'news' && posted.mornings[today]) {
        const cards = weekend ? [] : freshCards(news, posted, now)
        const results = freshResults(news, posted, now)
        const text = newsText(cards, results)
        if (text) await deliver(text, () => { for (const c of cards) posted.news[c.id] = now.toISOString(); told(results) }, resultLines(results))
    }
    if (kind === 'reminders') {
        for (const m of dueReminders(matches, posted, now)) {
            const text = reminderText(m, now)
            if (text) await deliver(text, () => { posted.reminders[m.key] = now.toISOString() })
        }
    }
    return { results, posted }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const kind = process.argv[2]
    if (!['morning', 'news', 'reminders'].includes(kind)) { console.error('node bot/post.mjs morning|news|reminders [--dry-run]'); process.exit(2) }
    const dryRun = process.argv.includes('--dry-run')
    const { results, posted } = await post(kind, { dryRun })
    if (!dryRun) writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2) + '\n')
    if (!results.length) console.log(`Nothing to post (${kind}).`)
    for (const r of results) console.log(r.sent ? `Posted (${r.status}).` : `Not sent (${r.why}):\n---\n${r.printed}\n---`)
}
