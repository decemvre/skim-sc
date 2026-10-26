#!/usr/bin/env node
// Skim Bot, F-287: a question asked in the group with /skim, answered in the group.
//
//   /skim cine joacă azi în ASL?
//   /skim when is Rush's next match?
//   /skim help  (or /skim ajutor) - what it can do, F-344
//
// About Korean StarCraft most of all, StarCraft anywhere in the world, and South Korea broadly
// (Silviu, 16 and 17 Oct), with every amount in won given in rough US dollars too. Only these
// answers range that wide: the bot's own posts stay Korean Brood War (bot/post.mjs, lib/scope.mjs).
//
// The WhatsApp bridge sees the message (it reads only messages that start with /skim) and runs
// this once per question. Claude Haiku looks in the bot's own records first, then searches - Korean
// sources first for anything Korean (eloboard, Naver, SOOP, the Korean press), and anywhere else,
// Google, YouTube, Liquipedia, tl.net, for StarCraft outside Korea - and answers in the language it was asked in, players by their ID, never
// by their real name. Links alone on their own line. Then the answer goes to the group through
// the bridge, like every other post.
//
// Unlike the bot's own posts it goes at any hour (somebody asked). A result - who won, a score,
// who advanced - only when the question explicitly asks for one (Silviu, 17 Oct): otherwise the
// bot's notes go to the model without results, and a last check drops any sentence with one.
//
//   node bot/ask.mjs --id <message id> --from <who asked> -- <the message>
//   node bot/ask.mjs --dry-run -- "/skim who is in the ASL final?"

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { send, SITE, REMIND_MIN } from './post.mjs'
import { loadWatchlist } from './watchlist.mjs'
import { upcomingLines } from './lib/importance.mjs'

export const MODEL = 'haiku'
export const ASKED_FILE = fileURLToPath(new URL('./data/asked.json', import.meta.url))
// How many questions the group gets answered: enough for a conversation, not for a loop.
export const LIMITS = { hour: 15, day: 60 }
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

export const NEWS_FILE = fileURLToPath(new URL('./data/news.json', import.meta.url))
export const MATCHES_FILE = fileURLToPath(new URL('./data/matches.json', import.meta.url))
const readJson = (file, empty) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return empty } }
// Does the question explicitly ask for a result? (Silviu, 17 Oct: never otherwise.)
const ASKS_RESULT = /\b(results?|scores?|who won|who lost|who wins|who will win|winner|did \w+ (win|lose|beat)|won\?|beat|final score|outcome|how did .* do)\b|rezultat|scor|c[âa]știg|castig|[îi]nvin|a b[ăa]tut|pierdut|cum s-a terminat|cum a ie[șs]it|결과|스코어|승리|우승|이겼/i
export const asksForResult = (question) => ASKS_RESULT.test(question || '')

// The last check on an answer nobody asked a result of: a sentence with a score or a
// won/beat/advanced in it is dropped.
// A score is 4-2, 3–1 or 3:1. Never hh:mm: a colon before two digits is a clock time, wherever
// the zone is written, or the sentence that answered "what time" was dropped as a result
// ("21:00 KST, 15:00 in Bucharest" lost the whole line, Silviu 17 Oct).
const SCORE = /\b\d{1,2}\s*[-–]\s*\d{1,2}\b(?!\s*(KST|Bucharest|Korea|Seoul|ora|time|[AaPp]M|h\b))|\b\d{1,2}\s*:\s*\d\b|\b(beats?|beaten|defeat\w*|wins?|won|winner|eliminat\w*|knock\w* out|advance[sd]?|swept|sweeps?)\b|\b(a )?(câștigat|castigat|învins|invins|bătut|batut|eliminat|calificat)\b/i
// University team results are the exception (Silviu, 17 Oct), as in the group posts: a sentence
// with one of the known ones - its score and one of its teams - stays.
export function teamResults (news = readJson(NEWS_FILE, { items: [] }).items || []) {
    return news.map((n) => String(n.teamResult || '').match(/^(?:.*?:\s*)?(.+?)\s+(\d+)\s*[-–:]\s*(\d+)\s+(.+)$/))
        .filter(Boolean).map(([, a, x, y, b]) => ({ a: a.trim(), b: b.trim(), x, y }))
}
const isTeamResult = (sentence, known) => known.some((r) => new RegExp(`\\b(${r.x}\\s*[-–:]\\s*${r.y}|${r.y}\\s*[-–:]\\s*${r.x})\\b`).test(sentence) &&
    [r.a, r.b].some((t) => sentence.toLowerCase().includes(t.toLowerCase())))
export function withoutResults (answer, known = []) {
    const kept = String(answer).split(/(?<=[.!?])\s+|\n/).filter((s) => !SCORE.test(s) || isTeamResult(s, known))
    return kept.join(' ').trim()
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// What Skim Bot already wrote down itself, for this question (G-116). Asked the score of that
// week's Light vs soma, it searched the web and could not confirm it, while its own news had held
// "soma beats Light 8-1" since the day after. The players the question names are matched against
// the bot's news and its schedule; with no player named, the last three days' news.
export function ownRecords (question, { news = readJson(NEWS_FILE, { items: [] }).items || [], matches = readJson(MATCHES_FILE, { matches: [] }).matches || [],
    watchlist = loadWatchlist(), now = new Date(), results = asksForResult(question) } = {}) {
    const people = new Map()
    const add = (p) => { if (p?.id) people.set(p.id.toLowerCase(), { id: p.id, korean: p.korean || people.get(p.id.toLowerCase())?.korean }) }
    for (const p of watchlist.players || []) add(p)
    for (const m of matches) { add(m.a); add(m.b) }
    const named = [...people.values()].filter((p) => new RegExp(`(^|[^\\p{L}])${escape(p.id)}($|[^\\p{L}])`, 'iu').test(question) || (p.korean && question.includes(p.korean)))
    const mentions = (text) => named.filter((p) => new RegExp(`(^|[^\\p{L}])${escape(p.id)}($|[^\\p{L}])`, 'iu').test(text) || (p.korean && text.includes(p.korean))).length
    const day = (d) => Date.parse(`${d}T00:00:00Z`)
    const recent = (d, days) => Math.abs(now - day(d)) <= days * 86400e3
    const pickedNews = news
        .filter((n) => n.date && recent(n.date, named.length ? 60 : 3))
        .map((n) => ({ n, hits: mentions(`${n.headline} ${n.summary} ${n.card || ''}`) }))
        .filter(({ hits }) => !named.length || hits > 0)
        .sort((x, y) => y.hits - x.hits || day(y.n.date) - day(x.n.date))
        .filter(({ n }) => results || !n.spoiler || n.card || n.teamResult)
        .slice(0, 8)
        // Not asked for a result: a spoiler item is told by its spoiler-free card and teaser only.
        .map(({ n }) => `- ${n.date}: ${results || !n.spoiler ? `${n.headline}. ${n.summary}` : `${n.card}.${n.teaser ? ' ' + n.teaser : ''}${n.teamResult ? ` University result: ${n.teamResult}.` : ''}`}${n.sources?.[0] ? ` (${n.sources[0]})` : ''}`)
    const pickedMatches = !named.length ? [] : matches
        .filter((m) => m.date && recent(m.date, 30) && [m.a, m.b].some((s) => s && named.some((p) => p.id.toLowerCase() === String(s.id).toLowerCase())))
        .sort((x, y) => day(y.date) - day(x.date))
        .slice(0, 8)
        .map((m) => `- ${m.date} ${m.kst || ''} KST (${m.bucharest?.time || '?'} Bucharest): ${m.a?.id} (${m.a?.race || '?'}) vs ${m.b?.id} (${m.b?.race || '?'}), ${m.competition?.name || m.competition?.raw || ''}, ${m.played ? 'played' : m.status || 'scheduled'}` +
            (m.result && results ? `, ${m.a?.id} ${m.result.a}-${m.result.b} ${m.b?.id}` : '') + (m.competition?.watch ? `, watch: ${m.competition.watch}` : ''))
    // The next 24 hours of the schedule, always, most important first (Silviu, 26 Oct): asked
    // "any important showmatches today?" with no player named, the bot had no schedule at all.
    const soon = upcomingLines(matches, { watchlist, now })
    if (!pickedNews.length && !pickedMatches.length && !soon.length) return ''
    return [soon.length ? `Skim Bot's schedule, the next 24 hours, MOST IMPORTANT FIRST (start times already worked out):\n${soon.join('\n')}` : '',
        pickedNews.length ? `News Skim Bot recorded (from eloboard.com and other Korean sources, read daily):\n${pickedNews.join('\n')}` : '',
        pickedMatches.length ? `Matches on Skim Bot's schedule:\n${pickedMatches.join('\n')}` : ''].filter(Boolean).join('\n\n')
}

export function prompt (question, { watchlist = loadWatchlist(), now = new Date(), records = ownRecords(question, { watchlist, now }) } = {}) {
    const kst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(now)
    return `You answer questions for a WhatsApp group of friends in Romania, experienced StarCraft players who do not read Korean. Most of all about Korean StarCraft: Brood War (players, matches, leagues such as the ASL, KSL, Race Wars, the star university leagues, streamers on SOOP/AfreecaTV); also StarCraft anywhere in the world - Brood War and StarCraft II, players, tournaments, streams, videos, history; and anything about South Korea: news, culture, places, food, games, prices.

It is now ${kst} in Korea.

The question:
${question}

${records ? `What we already know - Skim Bot's own records, most relevant first. Check these FIRST: if they answer the question, answer from them and give their source as the link${asksForResult(question) ? '; a score or result here is real, even when the web has nothing yet' : ''}. Search the web only for what these do not cover.

${records}

` : ''}How to answer:
1. Where to search (Silviu, 16 and 17 Oct). For anything Korean - Korean players, Korean leagues, Korea itself - search in Korean first: translate every name and term into Korean (players by their Korean name, leagues as Koreans write them) and search Korean sources - eloboard.com (results and news, every day), Naver news, blogs and cafés, sooplive.com / afreecatv.com (schedules, VODs, boards), the Korean press (OSEN, Sports Chosun, Inven, Daily eSports, Nate sports), Korean communities (fmkorea, dcinside); a result from this week is in the Korean sources days before it reaches English ones. For StarCraft outside Korea, or when the Korean sources have nothing, search anywhere: Google, YouTube (VODs, casts, interviews), Liquipedia, TeamLiquid (tl.net), Reddit, the players' and tournaments' own pages. Prefer the newest.
2. Answer in the language of the question: "ro" for Romanian, "en" for English. Romanian with diacritics.
3. Short: at most 5 lines, plain text, no markdown headings, no bullet lists of more than 4 items. A start time is its Bucharest time and how long until it - "14:00 Bucharest, in 4 h 35 min" - as the schedule above writes it; never "in X hours from now" next to a Korea time (Bucharest is 6 hours behind Korea in summer time, 7 in winter).
3b. Importance (Silviu, 26 Oct): a 1v1 between two of the top players listed in rule 4 - a [TOP-LEVEL 1v1] on the schedule - is MORE important than anything else, league games included. Asked what is important, name those first. Never call one less important because it is a showmatch. Check both players of every 1v1 against the list.
4. Players by their ID (Rush, Soulkey, Flash), never by their real name - not even in brackets. These IDs and Korean names are known: ${watchlist.players.map((p) => p.korean ? `${p.id} = ${p.korean}` : p.id).join(', ')}.
5. If you did not find it, say so in one line and say what you did find. Never guess a date, a time, a score or a result.
6. ${asksForResult(question) ? 'The question asks for a result: give it (who won, the score), if you found it.' : 'NO RESULTS (Silviu, 17 Oct). The question does not ask for one, so never say who won or lost, a score, who advanced, was knocked out or is in a final because of a win - not even of a match already played, not as an aside, not hinted ("a dominant performance"). Say only what was asked: when, where, who plays, where to watch. The one exception: a university team result written in the records as "University result: ..." may be given - the event, both teams and the team score, nothing about the games of a single player.'}
7. If the question is about neither StarCraft nor South Korea, say in one line that you answer about StarCraft and South Korea.
7b. Every amount in won is followed by its rough value in US dollars, at about 1,400 won to the dollar, in the answer's language - "₩5.000.000 (aprox. 3.600 $)" in Romanian, "₩5,000,000 (about $3,600)" in English. Round it; do not look the rate up.
8. "links": at most ${MAX_LINKS} source URLs you actually read that back the answer, best first; for a Korean topic, Korean sources first. No links in "answer" itself.

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
    const times = Object.entries(asked).filter(([id, a]) => !id.startsWith('_') && !a?.help).map(([, a]) => Date.parse(a.at)).filter(Boolean)
    const hour = times.filter((t) => now - t < 3600e3).length
    const day = times.filter((t) => now - t < 86400e3).length
    return hour >= LIMITS.hour ? 'hour' : day >= LIMITS.day ? 'day' : null
}

// "/skim help" (F-344): what Skim Bot does and how to ask it, written here rather than by the
// model, so it is the same every time and costs nothing. "/skim ajutor" is the Romanian, and a
// /skim with nothing after it gets the help too, as the likeliest thing it means.
const HELP_WORDS = /^(help|ajutor|\?|commands|comenzi)\W*$/i
export const asksForHelp = (question) => !question || HELP_WORDS.test(question)

export function helpText (ro = false) {
    return (ro ? [
        '🤖 *Skim Bot* - ce știu să fac',
        '',
        '*Întreabă-mă* scriind /skim și întrebarea, în română sau engleză:',
        '/skim cine joacă azi în ASL?',
        '/skim când e următorul meci al lui Rush?',
        '/skim ce mâncare să încerc în Seul?',
        '',
        '• StarCraft coreean mai ales: jucători, meciuri, ASL, KSL, ligile universitare, streamuri pe SOOP; StarCraft de oriunde, Brood War și SC2; și Coreea de Sud în general. Sumele în woni le dau și în dolari.',
        '• Mă uit întâi în notițele mele, apoi caut în sursele coreene și pe web, și pun cel mult 2 linkuri.',
        '• Orele le dau în ora Coreei și a Bucureștiului; jucătorii după ID, niciodată după numele real.',
        '• Fără spoilere: spun cine a câștigat sau scorul doar dacă întrebi asta.',
        `• Cel mult ${LIMITS.hour} întrebări pe oră și ${LIMITS.day} pe zi.`,
        '',
        `*Singur*, între 08:00 și 16:00 ora României: meciurile zilei dimineața, știri în zilele lucrătoare, un memento cu ${REMIND_MIN} de minute înainte de meciurile mari și rezultatele echipelor universitare.`,
        '',
        'Programul și știrile:',
        '',
        SITE,
    ] : [
        '🤖 *Skim Bot* - what I can do',
        '',
        '*Ask me* by writing /skim and your question, in English or Romanian:',
        '/skim who plays in the ASL today?',
        "/skim when is Rush's next match?",
        '/skim what food should I try in Seoul?',
        '',
        '• Korean StarCraft most of all: players, matches, the ASL, KSL, university leagues, streams on SOOP; StarCraft anywhere, Brood War and SC2; and South Korea in general. Amounts in won come with rough dollars.',
        '• I check my own notes first, then search Korean sources and the web, and add at most 2 links.',
        '• Times in Korea and Bucharest time; players by their ID, never their real name.',
        '• No spoilers: who won or the score only when that is what you ask.',
        `• At most ${LIMITS.hour} questions an hour and ${LIMITS.day} a day.`,
        '',
        `*On my own*, 08:00-16:00 Bucharest time: the day's matches in the morning, news on weekdays, a reminder ${REMIND_MIN} minutes before a major match, and university team results.`,
        '',
        'Schedule and news:',
        '',
        SITE,
    ]).join('\n')
}

export async function ask ({ id, from, text, now = new Date(), asked = loadAsked(), save = (a) => writeFileSync(ASKED_FILE, JSON.stringify(a, null, 2) + '\n'),
    model = claude, sender = send, dryRun = false } = {}) {
    const question = questionOf(text)
    if (id && asked[id]) return { skipped: 'already answered' }
    // Help is not a question: no model, and it does not count towards the limits.
    if (asksForHelp(question)) {
        if (id && !dryRun) { asked[id] = { at: now.toISOString(), from: from || null, help: true }; save(asked) }
        const reply = helpText(/ajutor|comenzi/i.test(question))
        return { reply, ...await sender(reply, { asked: true, dryRun }) }
    }
    const limit = overLimit(asked, now)
    if (limit) {
        // Said once per limit reached, not under every question after it: the first one over
        // the hour's limit hears when to ask again, the rest wait quietly (Silviu, 16 Oct).
        const told = Date.parse(asked._limitNotice?.at || '')
        if (told && now - told < (limit === 'hour' ? 3600e3 : 86400e3)) return { skipped: `over the limit for the ${limit}` }
        if (!dryRun) { asked._limitNotice = { at: now.toISOString(), limit }; save(asked) }
        const ro = romanian(question)
        const notice = `❓ ${from ? from + ': ' : ''}${question.slice(0, 120)}\n\n` + (limit === 'hour'
            ? (ro ? `Am răspuns la ${LIMITS.hour} întrebări în ultima oră. Întreabă din nou peste puțin timp.` : `I have answered ${LIMITS.hour} questions in the last hour. Ask again in a little while.`)
            : (ro ? `Am răspuns la ${LIMITS.day} întrebări azi. Revin mâine.` : `I have answered ${LIMITS.day} questions today. Back tomorrow.`))
        const result = await sender(notice, { asked: true, dryRun })
        return { skipped: `over the limit for the ${limit}`, reply: notice, ...result }
    }
    let reply
    try {
        const found = await model(prompt(question, { now }))
        if (!asksForResult(question)) found.answer = withoutResults(found.answer, teamResults()) || (romanian(question) ? 'Nu am găsit nimic fără să dau un rezultat.' : 'I found nothing I can say without giving a result away.')
        reply = replyText(from, question, found)
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
