// SOOP's official esports schedule for Brood War (스타1): esports.sooplive.com/schedule/sc1.
// The page draws itself in the browser, so it is read with Chrome headless and taken apart
// from its text, which is steadier than its generated class names:
//
//   10-17(Sat)
//   Google Play ASL Season 22
//   15:00
//   유영진(T)
//   vs            <- "SCORE" once it is played: SOOP hides the result behind a button
//   김민철(Z)
//   Upcoming      <- or Replay, LIVE
//
// Results are never read from here; the page shows none without a click.

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SCHEDULE = 'https://esports.sooplive.com/schedule/sc1'
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']

export function dumpPage (url, { timeout = 60000 } = {}) {
    const profile = mkdtempSync(join(tmpdir(), 'skim-soop-'))
    return new Promise((resolve, reject) => {
        execFile(CHROME[0], ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${profile}`, '--virtual-time-budget=15000', '--dump-dom', url],
            { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
                rmSync(profile, { recursive: true, force: true })
                if (error && !stdout) return reject(error)
                resolve(stdout)
            })
    })
}

export function textLines (html) {
    const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
    const text = body.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

const DAY = /^(\d{2})-(\d{2})\((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\)$/
const TIME = /^\d{1,2}:\d{2}$/
const SIDE = /^(.*?)\(([TZPR])\)$/
const STATUS = /^(Upcoming|Replay|LIVE|Live|Ended|Finished|Cancel(l)?ed)$/i

// The page's lines -> matches: { date, kst, competition, a, b, played, status }.
export function parseSchedule (lines, year) {
    const out = []
    let date = null
    for (let i = 0; i < lines.length; i++) {
        const day = DAY.exec(lines[i])
        if (day) { date = `${year}-${day[1]}-${day[2]}`; continue }
        if (!date || !TIME.test(lines[i + 1] || '')) continue
        const [competition, time, left, sep, right, status] = lines.slice(i, i + 6)
        if (!['vs', 'SCORE'].includes(sep)) continue
        const side = (raw) => { const m = SIDE.exec(raw); return m ? { korean: m[1].trim(), race: m[2] } : { korean: raw, race: null, team: true } }
        out.push({ date, kst: time.padStart(5, '0'), competition, a: side(left), b: side(right),
            played: sep === 'SCORE', status: STATUS.test(status || '') ? status : null })
        i += 5
    }
    return out
}

export async function schedule (date, { dump = dumpPage } = {}) {
    const html = await dump(`${SCHEDULE}?date=${date}`)
    return parseSchedule(textLines(html), date.slice(0, 4))
}
