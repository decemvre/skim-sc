#!/usr/bin/env node
// Skim Bot, F-236: what goes to the group chat, through the Friendzy WhatsApp bridge.
// Silviu's rules (10 Oct), all of them enforced here:
//
//   - NOTHING is posted outside 08:00-16:00 Bucharest time (this machine's time). send()
//     refuses, whatever called it.
//   - morning   one post with the day's highlights: today's matches (KST) and the news that
//               came in since the last post. On a weekend: only major matches, no news.
//   - news      relevant news (the Korean scene, or a watchlist player or team) as soon as it
//               is ready - weekdays, inside the window. Later news waits for the next weekday
//               morning's post. Never news on a weekend.
//   - reminder  30 minutes before a major match, any day - if that moment is inside the window.
//
// Nothing on a quiet day. Never a result: the text is built only from the schedule and the
// news items' spoiler-free cards, and a last check drops any line that looks like a score.
// English, links alone on their own line. Send-only: the bridge never reads the group.
//
// Which group: ~/.config/friendzy/skim-bot.json {"group": "<exact WhatsApp name>"}, and the
// same name in the bridge's "groups". Until both are set, a post is printed, not sent.

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadMatches } from './matches.mjs'
import { loadNews } from './digest.mjs'
import { kstToday } from './lib/time.mjs'

export const SITE = 'https://decemvre.github.io/skim-sc/'
export const CONFIG_FILE = join(homedir(), '.config/friendzy/skim-bot.json')
export const POSTED_FILE = fileURLToPath(new URL('./data/posted.json', import.meta.url))
export const BRIDGE = process.env.FRIENDZY_WHATSAPP_BRIDGE || 'http://127.0.0.1:8796'
export const REMIND_MIN = 30
export const WINDOW = { from: 8 * 60, to: 16 * 60, zone: 'Europe/Bucharest' }

export function local (now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: WINDOW.zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(now).map((p) => [p.type, p.value]))
    return { minutes: Number(parts.hour) * 60 + Number(parts.minute), weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' }
}
export const inWindow = (now = new Date()) => { const t = local(now).minutes; return t >= WINDOW.from && t < WINDOW.to }

const SCORE = /\b\d{1,2}\s*[-–:]\s*\d{1,2}\b|\b(beats?|beat|defeats?|defeated|wins?|won|eliminat\w*|knocks? out|knocked out|advances?|advanced)\b/i

export function loadPosted (file = POSTED_FILE) {
    try { return { mornings: {}, reminders: {}, news: {}, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { return { mornings: {}, reminders: {}, news: {} } }
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

// News worth a line: relevant, a spoiler-free card, not posted, added in the last five days
// (a Monday morning carries the weekend's), newest first, at most six.
export function freshCards (news, posted, now = new Date()) {
    return (news.items || []).filter((i) => i.relevant !== false && i.card && !SCORE.test(i.card) && !posted.news[i.id] &&
        now - Date.parse(i.addedAt || 0) < 5 * 86400000).slice(0, 6)
}

export function morningText (matches, cards, today, { weekend = false } = {}) {
    const todays = matches.filter((m) => m.date === today && m.onSchedule && !m.competition.celebrity && (!weekend || m.competition.big))
        .map((m) => ({ m, lines: matchLines(m) })).filter((x) => x.lines)
    const news = weekend ? [] : cards
    if (!todays.length && !news.length) return null
    const parts = [`🤖 Skim Bot - ${todays.length ? `Brood War in Korea today (${dayName(today)})` : `Brood War news (${dayName(today)})`}`]
    for (const { lines } of todays) parts.push(lines.join('\n'))
    const watch = [...new Set(todays.map(({ m }) => m.competition.watch).filter(Boolean))]
    if (watch.length) parts.push('Watch live:', ...watch)
    if (news.length) parts.push(`${todays.length ? 'News:\n' : ''}${news.map((c) => `• ${c.card}`).join('\n')}`)
    parts.push('More on the page:', SITE)
    return parts.join('\n\n')
}

export function newsText (cards) {
    if (!cards.length) return null
    return [`🤖 Skim Bot - Brood War news`, cards.map((c) => `• ${c.card}`).join('\n'), 'More on the page:', `${SITE}#news`].join('\n\n')
}

export function reminderText (m, now = new Date()) {
    const lines = matchLines(m)
    if (!lines) return null
    const minutes = Math.max(1, Math.round((Date.parse(m.at) - now) / 60000))
    return [`🤖 Starting in ${minutes} minutes`, lines.join('\n'), ...(m.competition.watch ? ['Watch live:', m.competition.watch] : [])].join('\n\n')
}

// Matches starting in the next REMIND_MIN (plus the watcher's 15 minutes of slack) not yet reminded.
export function dueReminders (matches, posted, now = new Date()) {
    return matches.filter((m) => m.competition.big && m.onSchedule && !m.played && !posted.reminders[m.key] &&
        Date.parse(m.at) - now > 0 && Date.parse(m.at) - now <= (REMIND_MIN + 15) * 60000)
}

// The last line of defence: nothing that looks like a result leaves this machine.
export function safe (text) {
    return text.split('\n').filter((line) => !(SCORE.test(line) && !/KST|Bucharest|https?:\/\//.test(line))).join('\n')
}

export async function send (text, { group = config().group, fetchImpl = fetch, dryRun = false, now = new Date() } = {}) {
    // The one rule nothing overrides: 08:00-16:00 Bucharest, or not at all.
    if (!inWindow(now)) throw new Error('outside 08:00-16:00 Bucharest: nothing is posted to the group')
    const body = safe(text)
    if (!group || dryRun) return { sent: false, printed: body, why: group ? 'dry run' : `no group set in ${CONFIG_FILE}` }
    const r = await fetchImpl(`${BRIDGE}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Friendzy-Office': '1' },
        body: JSON.stringify({ group, agent: 'skim', text: body }), signal: AbortSignal.timeout(6 * 60000) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || !data.sent) throw new Error(`the bridge did not post: ${data.error || r.status}`)
    return { sent: true, status: data.status }
}

export async function post (kind, { now = new Date(), posted = loadPosted(), matches = loadMatches().matches, news = loadNews(), dryRun = false, sender = send } = {}) {
    const today = kstToday(now)
    const results = []
    // Outside the window nothing happens at all - not even a reminder that would be late.
    if (!inWindow(now)) return { results, posted }
    const { weekend } = local(now)
    const deliver = async (text, after) => {
        const r = await sender(text, { dryRun, now })
        results.push(r)
        if (r.sent || dryRun) after()
    }
    if (kind === 'morning' && !posted.mornings[today]) {
        const cards = weekend ? [] : freshCards(news, posted, now)
        const text = morningText(matches, cards, today, { weekend })
        if (text) await deliver(text, () => { posted.mornings[today] = now.toISOString(); for (const c of cards) posted.news[c.id] = now.toISOString() })
        // A quiet morning is still a morning: news may follow during the day.
        else posted.mornings[today] = `nothing (${now.toISOString()})`
    }
    if (kind === 'news' && !weekend && posted.mornings[today]) {
        const cards = freshCards(news, posted, now)
        const text = newsText(cards)
        if (text) await deliver(text, () => { for (const c of cards) posted.news[c.id] = now.toISOString() })
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
