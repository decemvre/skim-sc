#!/usr/bin/env node
// Skim Bot, F-232: keep the public SkiM SC Google Calendar in step with bot/data/matches.json.
//
// Access: the service account skim-bot-calendar@project-bcbaadcc-fe79-4981-bd7.iam.gserviceaccount.com,
// which Silviu shares the calendar with ("Make changes to events"). No key file exists - the
// project forbids them, rightly - so a short-lived token is asked of gcloud on this machine,
// which may act as that account (roles/iam.serviceAccountTokenCreator for decemvre@gmail.com).
//
// What it does, per match from SOOP (celebrity leagues left out):
//   - an event it made before (extendedProperties.private.skimKey) is brought up to date;
//   - else a hand-made event at the same time for the same competition ("ASL S22 Final — TBD vs
//     TBD") is adopted: its stage is kept and the players filled in;
//   - else one is created.
//   A match that has left SOOP's schedule is never deleted: its event is marked [?] for a person.
//   Events nobody can tie to a SOOP match - the hand-made ones for other cups - are not touched.
//
//   node bot/calendar.mjs --dry-run   print the plan, change nothing
//   node bot/calendar.mjs             apply it

import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { loadMatches } from './matches.mjs'
import { kstToday } from './lib/time.mjs'

export const CALENDAR = '7341530260f66ff6a15c54f7ba59de47159d615563d7c7dfd5793fd731856d53@group.calendar.google.com'
export const SERVICE_ACCOUNT = 'skim-bot-calendar@project-bcbaadcc-fe79-4981-bd7.iam.gserviceaccount.com'
const API = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events`
const HOURS = 2 // how long an event is drawn for; Brood War nights rarely run shorter

export function token () {
    return new Promise((resolve, reject) => execFile('gcloud', ['auth', 'print-access-token', `--impersonate-service-account=${SERVICE_ACCOUNT}`,
        '--scopes=https://www.googleapis.com/auth/calendar'], { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`gcloud would not give a token: ${(stderr || error.message).trim().split('\n').pop()}`))
        resolve(stdout.trim())
    }))
}

// "ASL Season 22" -> "ASL S22", the way the calendar has always been written.
export const shortName = (name) => name.replace(/\bSeason\s+(\d+)/i, 'S$1')
const who = (s) => s.team || s.id || `? (${s.race})`

export function summaryFor (match, existing = null) {
    const players = `${who(match.a)} vs ${who(match.b)}`
    // An adopted event keeps what a person wrote before the dash: "ASL S22 Final".
    const head = existing ? existing.split(' — ')[0].replace(/^\[\?\]\s*/, '') : shortName(match.competition.name)
    return `${match.onSchedule ? '' : '[?] '}${head} — ${players}`
}

export function descriptionFor (match) {
    return [`${match.competition.name}: ${who(match.a)} vs ${who(match.b)}`,
        `${match.kst} KST / ${match.bucharest.time} ${match.bucharest.zone} (Bucharest)`,
        match.onSchedule ? '' : 'No longer on SOOP\'s schedule - moved or cancelled? Check the source.',
        `Source: ${match.source}`,
        match.competition.watch ? `Watch: ${match.competition.watch}` : '',
        'Kept up to date by Skim Bot - https://decemvre.github.io/skim-sc/'].filter(Boolean).join('\n')
}

// Words that say which event this is, for matching a hand-made event to an EloBoard entry.
const GENERIC = new Set(['the', 'and', 'vs', 'tournament', 'university', 'universities', 'match', 'mini', 'star', 'cup', 'tier', 'brood', 'war', 'starcraft', 'clash', 'battle', 'special', 'ultimate'])
const tokens = (text) => new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g)?.filter((w) => !GENERIC.has(w)) || [])

function eloboardBody (m) {
    const base = {
        summary: m.titleEn,
        description: [`${m.titleEn}`, m.kst ? `${m.kst} KST / ${m.bucharest.time} ${m.bucharest.zone} (Bucharest)` : 'All day (KST)',
            `Source: ${m.source}`, 'Kept up to date by Skim Bot - https://decemvre.github.io/skim-sc/'].join('\n'),
        extendedProperties: { private: { skimKey: m.key } },
    }
    if (m.allDay) {
        const next = new Date(Date.parse(`${m.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
        return { ...base, start: { date: m.date }, end: { date: next } }
    }
    return { ...base, start: { dateTime: m.at, timeZone: 'Asia/Seoul' }, end: { dateTime: new Date(Date.parse(m.at) + HOURS * 3600000).toISOString(), timeZone: 'Asia/Seoul' } }
}

// The plan: what to create, update or adopt. Pure, so it can be tested and dry-run.
export function plan (matches, events, { today = kstToday() } = {}) {
    const byKey = new Map(events.filter((e) => e.extendedProperties?.private?.skimKey).map((e) => [e.extendedProperties.private.skimKey, e]))
    const taken = new Set()
    const steps = []
    for (const m of matches) {
        if (m.competition.celebrity || m.date < today) continue
        if (m.origin === 'eloboard') {
            if (m.needsTranslation) continue
            const mine = byKey.get(m.key)
            const body = eloboardBody(m)
            if (mine) {
                taken.add(mine.id)
                // An adopted hand-made event keeps the words a person gave it.
                if (mine.extendedProperties?.private?.skimKeepSummary) body.summary = mine.summary
                if (mine.summary !== body.summary || (mine.description || '') !== body.description) steps.push({ do: 'update', id: mine.id, was: mine.summary, body: { ...body, extendedProperties: mine.extendedProperties } })
                continue
            }
            const ours = tokens(m.titleEn)
            const eventDate = (e) => e.start?.date || (e.start?.dateTime ? new Date(Date.parse(e.start.dateTime) + 9 * 3600000).toISOString().slice(0, 10) : null)
            const handMade = events.find((e) => !taken.has(e.id) && !e.extendedProperties?.private?.skimKey && eventDate(e) === m.date &&
                [...tokens(e.summary)].some((w) => ours.has(w)))
            if (handMade) {
                taken.add(handMade.id)
                steps.push({ do: 'adopt', id: handMade.id, was: handMade.summary, body: { summary: handMade.summary, description: body.description,
                    extendedProperties: { private: { skimKey: m.key, skimKeepSummary: '1' } } } })
            } else steps.push({ do: 'create', body })
            continue
        }
        const body = (existing) => ({
            summary: summaryFor(m, existing?.summary || null),
            description: descriptionFor(m),
            start: { dateTime: m.at, timeZone: 'Asia/Seoul' },
            end: { dateTime: new Date(Date.parse(m.at) + HOURS * 3600000).toISOString(), timeZone: 'Asia/Seoul' },
            extendedProperties: { private: { skimKey: m.key } },
        })
        const mine = byKey.get(m.key)
        if (mine) {
            taken.add(mine.id)
            const next = body(mine)
            if (mine.summary !== next.summary || (mine.description || '') !== next.description || Date.parse(mine.start?.dateTime) !== Date.parse(m.at)) steps.push({ do: 'update', id: mine.id, was: mine.summary, body: next })
            continue
        }
        const head = shortName(m.competition.name).toLowerCase()
        const handMade = events.find((e) => !taken.has(e.id) && !e.extendedProperties?.private?.skimKey &&
            Date.parse(e.start?.dateTime) === Date.parse(m.at) && (e.summary || '').toLowerCase().startsWith(head))
        if (handMade) {
            taken.add(handMade.id)
            steps.push({ do: 'adopt', id: handMade.id, was: handMade.summary, body: body(handMade) })
        } else steps.push({ do: 'create', body: body(null) })
    }
    return steps
}

async function api (method, url, tokenValue, body) {
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${tokenValue}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`Calendar ${method}: ${data.error?.message || response.status}`)
    return data
}

export async function sync ({ dryRun = false, today = kstToday() } = {}) {
    const t = await token()
    const from = new Date(Date.parse(`${today}T00:00:00+09:00`) - 86400000).toISOString()
    const listed = await api('GET', `${API}?singleEvents=true&maxResults=250&timeMin=${encodeURIComponent(from)}`, t)
    const steps = plan(loadMatches().matches, listed.items || [], { today })
    const canWrite = listed.accessRole === 'writer' || listed.accessRole === 'owner'
    // Shared read-only (or not yet): the plan is all there is to give.
    if (!canWrite) dryRun = true
    const done = []
    for (const step of steps) {
        if (!dryRun) {
            if (step.do === 'create') await api('POST', API, t, step.body)
            else await api('PATCH', `${API}/${encodeURIComponent(step.id)}`, t, step.body)
        }
        done.push(`${dryRun ? 'would ' : ''}${step.do}: ${step.was ? `"${step.was}" -> ` : ''}"${step.body.summary}"`)
    }
    return { steps: done, canWrite, accessRole: listed.accessRole }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const dryRun = process.argv.includes('--dry-run')
    const result = await sync({ dryRun: true })
    if (!dryRun && !result.canWrite) {
        console.log(`The calendar is shared with ${SERVICE_ACCOUNT} as "${result.accessRole}", not "Make changes to events". Nothing changed. The plan:`)
    } else if (!dryRun) {
        const applied = await sync({ dryRun: false })
        console.log(applied.steps.join('\n') || 'Calendar already up to date.')
        process.exit(0)
    }
    console.log(result.steps.join('\n') || 'Calendar already up to date.')
}
