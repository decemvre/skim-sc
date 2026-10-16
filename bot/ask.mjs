#!/usr/bin/env node
// Skim Bot, F-287: a question asked in the group with /skim, answered in the group.
//
//   /skim cine joacă azi în ASL?
//   /skim when is Rush's next match?
//
// The WhatsApp bridge sees the message (it reads only messages that start with /skim) and runs
// this once per question. Claude Haiku searches the Korean sources - Naver, SOOP, Liquipedia,
// the Korean press - and answers in the language it was asked in, players by their ID, never
// by their real name. Links alone on their own line. Then the answer goes to the group through
// the bridge, like every other post.
//
// Unlike the bot's own posts it goes at any hour (somebody asked), and it says a result when
// the question asks for one.
//
//   node bot/ask.mjs --id <message id> --from <who asked> -- <the message>
//   node bot/ask.mjs --dry-run -- "/skim who is in the ASL final?"

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { send } from './post.mjs'
import { loadWatchlist } from './watchlist.mjs'

export const MODEL = 'haiku'
export const ASKED_FILE = fileURLToPath(new URL('./data/asked.json', import.meta.url))
// How many questions the group gets answered: enough for a conversation, not for a loop.
export const LIMITS = { hour: 6, day: 30 }
export const MAX_LINKS = 2
const PREFIX = /^\s*[/@]skim\b[:,]?\s*/i

const SCHEMA = {
    type: 'object',
    properties: {
        language: { type: 'string', enum: ['ro', 'en'] },
        answer: { type: 'string' },
        links: { type: 'array', items: { type: 'string' } },
    },
    required: ['language', 'answer', 'links'],
}

// The question without its /skim. Empty when there is none.
export const questionOf = (text) => String(text || '').replace(PREFIX, '').trim()

// A guess at the language without a model, for the one message written when the model failed.
export const romanian = (text) => /[ăâîșțşţ]|\b(cine|ce|c[aâ]nd|unde|care|azi|m[aâ]ine|meci|meciul|joac[aă]|cum|c[aâ]t)\b/i.test(text)

export function prompt (question, { watchlist = loadWatchlist(), now = new Date() } = {}) {
    const kst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(now)
    return `You answer questions about Korean StarCraft: Brood War (players, matches, leagues such as the ASL, KSL, Race Wars, the star university leagues, streamers on SOOP/AfreecaTV) for a WhatsApp group of friends in Romania who do not read Korean.

It is now ${kst} in Korea.

The question:
${question}

How to answer:
1. Search the web in Korean first - Naver (news and blogs), sooplive.com / afreecatv.com, the Korean press, Korean community sites - and Liquipedia (liquipedia.net/starcraft) for brackets and schedules. Translate names and terms into Korean to search. Read the pages you need; prefer the newest.
2. Answer in the language of the question: "ro" for Romanian, "en" for English. Romanian with diacritics.
3. Short: at most 5 lines, plain text, no markdown headings, no bullet lists of more than 4 items. Times as Korea time and Bucharest time (Bucharest is 6 hours behind Korea in summer time, 7 in winter).
4. Players by their ID (Rush, Soulkey, Flash), never by their real name - not even in brackets. These IDs and Korean names are known: ${watchlist.players.map((p) => p.korean ? `${p.id} = ${p.korean}` : p.id).join(', ')}.
5. If you did not find it, say so in one line and say what you did find. Never guess a date, a time, a score or a result.
6. A result (who won, a score) only when the question asks for it.
7. If the question is not about StarCraft or its scene, say in one line that you only answer about Korean StarCraft.
8. "links": at most ${MAX_LINKS} source URLs you actually read that back the answer, best first. No links in "answer" itself.

Answer with JSON only, in the given shape.`
}

function run (cmd, args, input, timeout = 240000) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`${cmd}: ${(stderr || error.message).trim().split('\n').slice(-2).join(' ')}`))
            resolve(stdout)
        })
        child.stdin.end(input)
    })
}

export async function claude (text, runner = run) {
    const out = await runner('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
        '--no-session-persistence', '--strict-mcp-config', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'], text)
    const envelope = JSON.parse(out)
    if (envelope.is_error) throw new Error(`claude: ${envelope.result || 'error'}`)
    const found = envelope.structured_output || JSON.parse(String(envelope.result).replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (!found?.answer) throw new Error('claude: no answer')
    return found
}

// What goes to the group: who asked what, the answer, then each link alone on its own line.
export function replyText (from, question, found) {
    const asked = question.length > 120 ? question.slice(0, 117) + '…' : question
    const links = (found.links || []).filter((l) => /^https?:\/\/\S+$/.test(l)).slice(0, MAX_LINKS)
    return [`❓ ${from ? from + ': ' : ''}${asked}`, '', found.answer.trim(), ...links.flatMap((l) => ['', l])].join('\n')
}

export function loadAsked (file = ASKED_FILE) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

// Over the limit: how many were answered in the last hour and the last day.
export function overLimit (asked, now = new Date()) {
    const times = Object.values(asked).map((a) => Date.parse(a.at)).filter(Boolean)
    const hour = times.filter((t) => now - t < 3600e3).length
    const day = times.filter((t) => now - t < 86400e3).length
    return hour >= LIMITS.hour ? 'hour' : day >= LIMITS.day ? 'day' : null
}

export async function ask ({ id, from, text, now = new Date(), asked = loadAsked(), save = (a) => writeFileSync(ASKED_FILE, JSON.stringify(a, null, 2) + '\n'),
    model = claude, sender = send, dryRun = false } = {}) {
    const question = questionOf(text)
    if (!question) return { skipped: 'no question' }
    if (id && asked[id]) return { skipped: 'already answered' }
    const limit = overLimit(asked, now)
    if (limit) return { skipped: `over the limit for the ${limit}` }
    let reply
    try {
        reply = replyText(from, question, await model(prompt(question, { now })))
    } catch (error) {
        console.error(`ask: ${error.message}`)
        reply = `❓ ${from ? from + ': ' : ''}${question.slice(0, 120)}\n\n` + (romanian(question)
            ? 'Nu am putut căuta acum. Încearcă din nou peste câteva minute.'
            : 'I could not search just now. Try again in a few minutes.')
    }
    if (id && !dryRun) { asked[id] = { at: now.toISOString(), from: from || null }; save(asked) }
    const result = await sender(reply, { asked: true, dryRun })
    return { reply, ...result }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const args = process.argv.slice(2)
    const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
    const split = args.indexOf('--')
    const text = split >= 0 ? args.slice(split + 1).join(' ') : ''
    const result = await ask({ id: flag('--id'), from: flag('--from'), text, dryRun: args.includes('--dry-run') })
    console.log(JSON.stringify(result, null, 2))
}
