// Skim Bot, F-233: the part of docs/index.html the bot keeps - between
// <!-- skim-bot:schedule:start --> and <!-- skim-bot:schedule:end -->, before "On the circuit".
// Everything outside the markers stays the hand-written guide it was.
//
// The site's rules hold: static HTML, no scripts, KST and Bucharest time, player IDs only.
// Results are spoilers: they sit in a closed <details>, which needs no script to open.

import { bucharest } from './lib/time.mjs'

export const START = '<!-- skim-bot:schedule:start -->'
export const END = '<!-- skim-bot:schedule:end -->'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const RACE = { T: ['race-t', 'Terran'], Z: ['race-z', 'Zerg'], P: ['race-p', 'Protoss'], R: ['race-r', 'Random'] }

function side (s) {
    if (s.team) return `<span class="player-chip team-chip" lang="ko">${esc(s.team)}</span>`
    const [cls, label] = RACE[s.race] || ['', '']
    const race = s.race ? ` <span class="race ${cls}" aria-label="${label}">${s.race}</span>` : ''
    return `<span class="player-chip">${s.id ? esc(s.id) : '<span title="Not matched to a player ID yet">?</span>'}${race}</span>`
}

const day = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

// One match as a compact entry for the right-hand column (F-241): when, competition, players.
function row (m, withResult = false) {
    const when = `${esc(day(m.date))} · ${m.kst ? `${esc(m.kst)} KST · ${esc(m.bucharest.time)} ${esc(m.bucharest.zone)}` : 'all day'}`
    // An EloBoard entry (F-238): its English title in place of two players.
    if (m.origin === 'eloboard') {
        return `<li class="fixture"><p class="fixture-when">${when}</p><p class="fixture-comp">Star universities <small>(EloBoard)</small></p><p class="fixture-players">${esc(m.titleEn)}</p></li>`
    }
    const players = `${side(m.a)} <span class="versus">${withResult && m.result ? `${m.result.a}–${m.result.b}` : 'vs'}</span> ${side(m.b)}`
    return `<li class="fixture${m.competition.big ? ' big' : ''}"><p class="fixture-when">${when}</p>` +
        `<p class="fixture-comp">${esc(m.competition.name)}${m.onSchedule ? '' : ' <small>(no longer on the schedule)</small>'}</p><p class="fixture-players">${players}</p></li>`
}

export const CALENDAR = 'https://calendar.google.com/calendar/u/0?cid=NzM0MTUzMDI2MGY2NmZmNmExNWM1NGY3YmE1OWRlNDcxNTlkNjE1NTYzZDdjN2RmZDU3OTNmZDczMTg1NmQ1M0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t'

export function section (file, { today, now = new Date() }) {
    const upcoming = file.matches.filter((m) => m.date >= today && !m.played && !m.needsTranslation).slice(0, 16)
    const past = file.matches.filter((m) => m.origin !== 'eloboard' && m.played && m.date <= today).slice(-10).reverse()
    const checked = bucharest(now)
    const list = (rows, label) => `<ul class="fixtures" aria-label="${label}">${rows}</ul>`
    return `${START}
<section id="schedule" class="section" aria-labelledby="schedule-title">
  <div class="section-heading"><div><p class="eyebrow">SOOP · ELOBOARD</p><h2 id="schedule-title">Coming up</h2></div></div>
  <p class="section-note">Checked ${esc(checked.date)} ${esc(checked.time)} ${esc(checked.zone)}. Players by ID; “?” is one not matched yet.</p>
  ${upcoming.length ? list(upcoming.map((m) => row(m)).join(''), 'Upcoming matches') : '<p class="section-note">Nothing on SOOP\'s schedule yet.</p>'}
  <a id="calendar" class="text-link" href="${CALENDAR}">Add to Google Calendar <span aria-hidden="true">↗</span></a>
  ${past.length ? `<details class="spoilers"><summary>Results <span>(spoilers)</span></summary>${list(past.map((m) => row(m, true)).join(''), 'Recent results, newest first')}<p class="section-note">Scores from Liquipedia where it has them; “vs” means no score yet.</p></details>` : ''}
</section>
${END}`
}

// Put the section into the page: replace what is between the markers, or the first time, place
// it just before "On the circuit".
export function inject (html, block) {
    const a = html.indexOf(START), b = html.indexOf(END)
    if (a >= 0 && b > a) return html.slice(0, a) + block + html.slice(b + END.length)
    const anchor = html.indexOf('<section id="tournaments"')
    if (anchor < 0) throw new Error('docs/index.html has no "On the circuit" section to go before')
    return html.slice(0, anchor) + block + '\n' + html.slice(anchor)
}

// The news (F-234), after the schedule, between its own markers. A story that reveals a result
// shows only its spoiler-free card; its headline and text wait behind a closed <details>.
export const NEWS_START = '<!-- skim-bot:news:start -->'
export const NEWS_END = '<!-- skim-bot:news:end -->'

// Only the last week's Korean news (Silviu, 10 Oct: old news off the page).
export const NEWS_DAYS = 7
const foreign = (i) => (i.sources || []).some((s) => /tl\.net|teamliquid/i.test(s))
export function newsSection (news, { limit = 12, now = new Date() } = {}) {
    const since = new Date(now - NEWS_DAYS * 86400000).toISOString().slice(0, 10)
    const items = (news.items || []).filter((i) => !foreign(i) && String(i.date) >= since).slice(0, limit)
    const links = (i) => i.sources.map((s, n) => `<a class="source-link" href="${esc(s)}">${n ? `source ${n + 1}` : 'Source'} <span aria-hidden="true">↗</span></a>`).join(' ')
    const article = (i) => i.spoiler
        ? `<article class="news-item"><p class="eyebrow">${esc(i.date)}</p><h3>${esc(i.card || 'A result from the Korean scene')}</h3>${i.teaser ? `<p>${esc(i.teaser)}</p>` : ''}<details class="spoilers"><summary>Show the story <span>(spoiler)</span></summary><h4>${esc(i.headline)}</h4><p>${esc(i.summary)}</p>${links(i)}</details></article>`
        : `<article class="news-item"><p class="eyebrow">${esc(i.date)}</p><h3>${esc(i.headline)}</h3><p>${esc(i.summary)}</p>${links(i)}</article>`
    return `${NEWS_START}
<section id="news" class="section" aria-labelledby="news-title">
  <div class="section-heading"><div><p class="eyebrow">PUBLISHED IN SOUTH KOREA · IN ENGLISH</p><h2 id="news-title">Brood War news</h2></div><p class="section-note">The last week, from Korean outlets (via Naver Sports) and EloBoard. Players by ID, never by name; results are folded.</p></div>
  ${items.length ? `<div class="news-grid">${items.map(article).join('')}</div>` : '<p class="section-note">No news yet.</p>'}
</section>
${NEWS_END}`
}

export function injectNews (html, block) {
    const a = html.indexOf(NEWS_START), b = html.indexOf(NEWS_END)
    if (a >= 0 && b > a) return html.slice(0, a) + block + html.slice(b + NEWS_END.length)
    const after = html.indexOf(END)
    if (after < 0) throw new Error('the schedule section must be in the page before the news')
    return html.slice(0, after + END.length) + '\n' + block + html.slice(after + END.length)
}
