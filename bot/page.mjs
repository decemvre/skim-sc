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

function row (m, withResult = false) {
    const players = `${side(m.a)} <span class="versus">${withResult && m.result ? `${m.result.a}–${m.result.b}` : 'vs'}</span> ${side(m.b)}`
    return `<tr><th scope="row">${esc(day(m.date))}</th><td class="when">${esc(m.kst)} KST<br><small>${esc(m.bucharest.time)} ${esc(m.bucharest.zone)}</small></td>` +
        `<td>${esc(m.competition.name)}${m.onSchedule ? '' : ' <small>(no longer on the schedule)</small>'}</td><td>${players}</td></tr>`
}

export function section (file, { today, now = new Date() }) {
    const upcoming = file.matches.filter((m) => m.date >= today && !m.played).slice(0, 12)
    const past = file.matches.filter((m) => m.played && m.date < today || (m.played && m.date === today)).slice(-10).reverse()
    const checked = bucharest(now)
    const table = (rows, caption) => `<table class="matches bot-matches"><caption>${caption}</caption><thead><tr><th scope="col">Date</th><th scope="col">Time</th><th scope="col">Competition</th><th scope="col">Players</th></tr></thead><tbody>${rows}</tbody></table>`
    return `${START}
<section id="schedule" class="section" aria-labelledby="schedule-title">
  <div class="section-heading"><div><p class="eyebrow">KEPT UP TO DATE BY SKIM BOT</p><h2 id="schedule-title">Coming up</h2></div><p class="section-note">From SOOP's official schedule, checked ${esc(checked.date)} ${esc(checked.time)} ${esc(checked.zone)}. Players by ID; “?” is one not matched yet. Times in KST and Bucharest.</p></div>
  ${upcoming.length ? table(upcoming.map((m) => row(m)).join(''), 'Upcoming matches') : '<p class="section-note">Nothing on SOOP\'s schedule yet.</p>'}
  ${past.length ? `<details class="spoilers"><summary>Results <span>(spoilers - click to show)</span></summary>${table(past.map((m) => row(m, true)).join(''), 'Recent results, newest first')}<p class="section-note">Scores from Liquipedia where it has them; a match shown with “vs” has no score yet.</p></details>` : ''}
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
