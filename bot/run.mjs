#!/usr/bin/env node
// Skim Bot, O-98: one pass of everything, every 15 minutes (systemd timer skim-bot.timer).
// Each step runs when it is due and on its own: one failing never stops the rest, and a
// failure is said once a day in the Friendzy war room (@claude).
//
//   step       when                                   model?
//   pull       every pass (the bot's own clone)       no
//   schedule   hourly - SOOP, names, calendar sync    no
//   news       hourly - Naver, EloBoard               no
//   digest     queue not empty, weekdays 07:30-16:00   yes - Claude, Grok if it fails; at most 8 a day
//   results    once a day after 20:00 - Liquipedia     no
//   publish    when something changed - page, push     no
//   posts      morning / news / reminders, 08:00-16:00 no
//
// The model is asked only when the watcher has found something, so a quiet day costs nothing.
// State (when each step last ran) is in bot/data/run-state.json, which is not in the repo.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MATCHES_FILE, refresh } from './matches.mjs'
import { schedule as eloboardSchedule } from './sources/eloboard.mjs'
import { saveNames, loadNames } from './lib/names.mjs'
import { check, QUEUE_FILE } from './news.mjs'
import { digest, NEWS_FILE } from './digest.mjs'
import { addResults } from './results.mjs'
import { publish } from './publish.mjs'
import { loadPosted, local, post, POSTED_FILE } from './post.mjs'
import { sync as syncCalendar } from './calendar.mjs'
import { loadMatches } from './matches.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const STATE_FILE = fileURLToPath(new URL('./data/run-state.json', import.meta.url))
export const MODEL_RUNS_PER_DAY = 8
const WAR_ROOM = process.env.FRIENDZY_WAR_ROOM || 'http://127.0.0.1:8765'

const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { last: {}, modelRuns: {}, said: {} } } }
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n')
const due = (state, step, everyMs, now) => !state.last[step] || now - Date.parse(state.last[step]) >= everyMs
const localDate = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(now)

async function tellWarRoom (text) {
    try {
        await fetch(`${WAR_ROOM}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'system', kind: 'status', text }), signal: AbortSignal.timeout(5000) })
    } catch { /* the room being down is no reason to stop */ }
}

// One news source not answering is not a failed pass while another one did (B-355, 30 Oct: Naver's
// API stopped answering this machine at 22:46 on 29 Oct, and every hourly pass went red with
// everything else done). The pass still fails when no source answered, or when the same one has
// been silent for a day: a source that is gone for good has to be looked at.
export const NEWS_DOWN_LIMIT_MS = 24 * 3600000
export function newsProblem ({ errors = [], failed = [], sources = [] }, state, now = new Date()) {
    state.newsDown ||= {}
    for (const name of Object.keys(state.newsDown)) if (!failed.includes(name)) delete state.newsDown[name]
    for (const name of failed) state.newsDown[name] ||= now.toISOString()
    if (!errors.length) return null
    if (failed.length >= sources.length) return errors.join('; ')
    const long = failed.filter((name) => now - Date.parse(state.newsDown[name]) >= NEWS_DOWN_LIMIT_MS)
    return long.length ? `${long.join(', ')} silent since ${long.map((name) => state.newsDown[name]).join(', ')}: ${errors.join('; ')}` : null
}

export async function tick ({ now = new Date(), state = loadState(), log = console.log } = {}) {
    const errors = []
    let changed = false
    const step = async (name, fn) => {
        try { await fn() } catch (error) { errors.push(`${name}: ${error.message}`); log(`${name}: FAILED - ${error.message}`) }
    }
    const { minutes, weekend } = local(now)

    await step('pull', async () => { execFileSync('git', ['pull', '-q', '--rebase', '--autostash'], { cwd: ROOT, timeout: 60000 }) })

    if (due(state, 'schedule', 60 * 60000, now)) await step('schedule', async () => {
        // EloBoard every three hours (a month page and up to a week of day pages); SOOP hourly.
        const withEloboard = due(state, 'eloboard', 3 * 3600000, now)
        const r = await refresh({ now, eloboard: withEloboard ? eloboardSchedule : null })
        if (withEloboard) state.last.eloboard = now.toISOString()
        writeFileSync(MATCHES_FILE, JSON.stringify(r.file, null, 2) + '\n')
        saveNames(r.names)
        state.last.schedule = now.toISOString()
        if (r.changes.length) { changed = true; log(`schedule: ${r.changes.length} change(s)`) }
        if (r.changes.length || due(state, 'calendar', 24 * 3600000, now)) {
            const c = await syncCalendar({ dryRun: false })
            state.last.calendar = now.toISOString()
            if (!c.canWrite) log('calendar: shared read-only so far - nothing changed')
            else if (c.steps.length) log(`calendar: ${c.steps.join('; ')}`)
        }
    })

    if (due(state, 'news', 60 * 60000, now)) await step('news', async () => {
        const r = await check({ now })
        writeFileSync(QUEUE_FILE, JSON.stringify(r.queue, null, 2) + '\n')
        state.last.news = now.toISOString()
        if (r.fresh.length) log(`news: ${r.fresh.length} new`)
        const problem = newsProblem(r, state, now)
        if (problem) throw new Error(problem)
        if (r.errors.length) log(`news: ${r.errors.join('; ')} - the other sources ran`)
    })

    const today = localDate(now)
    const runsToday = state.modelRuns[today] || 0
    if (!weekend && minutes >= 7 * 60 + 30 && minutes < 16 * 60 && runsToday < MODEL_RUNS_PER_DAY) await step('digest', async () => {
        const pendingTitles = loadMatches().matches.filter((m) => m.needsTranslation).map((m) => m.titleSource)
        const r = await digest({ now, titles: pendingTitles })
        if (!r.ran) return
        if (Object.keys(r.translated).length) {
            const file = loadMatches()
            for (const m of file.matches) if (m.needsTranslation && r.translated[m.titleSource]) {
                m.titleEn = r.translated[m.titleSource]; m.competition.name = m.titleEn; m.needsTranslation = false
            }
            writeFileSync(MATCHES_FILE, JSON.stringify(file, null, 2) + '\n')
        }
        state.modelRuns = { [today]: runsToday + 1 }
        writeFileSync(NEWS_FILE, JSON.stringify(r.news, null, 2) + '\n')
        writeFileSync(QUEUE_FILE, JSON.stringify(r.queue, null, 2) + '\n')
        saveNames(r.names)
        if (r.added.length) changed = true
        log(`digest (${r.by}): ${r.added.length} item(s), run ${runsToday + 1} of ${MODEL_RUNS_PER_DAY} today`)
    })

    if (minutes >= 20 * 60 && state.last.results !== today) await step('results', async () => {
        const file = loadMatches()
        const found = await addResults(file.matches)
        writeFileSync(MATCHES_FILE, JSON.stringify(file, null, 2) + '\n')
        state.last.results = today
        if (found) { changed = true; log(`results: ${found} found`) }
    })

    if (changed || due(state, 'publish', 6 * 3600000, now)) await step('publish', async () => {
        const r = publish({ now })
        state.last.publish = now.toISOString()
        if (r.changed) log(`publish: ${r.pushed ? 'pushed' : r.committed ? 'committed (' + (r.why || 'not pushed') + ')' : 'rendered'}`)
    })

    await step('posts', async () => {
        const posted = loadPosted()
        // Written even when a post fails: one that may have gone out is recorded (UnsureError).
        try {
            for (const kind of ['morning', 'news', 'reminders']) {
                const r = await post(kind, { now, posted })
                for (const x of r.results) log(`post ${kind}: ${x.sent ? 'sent' : 'not sent (' + x.why + ')'}`)
            }
        } finally {
            writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2) + '\n')
        }
    })

    // Each distinct failure is said in the war room once a day.
    for (const e of errors) {
        const key = `${today} ${e.slice(0, 80)}`
        if (state.said[key]) continue
        state.said = Object.fromEntries(Object.entries(state.said).filter(([k]) => k.startsWith(today)))
        state.said[key] = now.toISOString()
        await tellWarRoom(`@claude Skim Bot: ${e}`)
    }
    saveState(state)
    return { errors }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const { errors } = await tick()
    process.exit(errors.length ? 1 : 0)
}
