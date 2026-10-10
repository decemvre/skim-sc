#!/usr/bin/env node
// Skim Bot, F-233: put the bot's section into docs/index.html and publish it - commit and push
// to main, which GitHub Pages serves. A morning with nothing new makes no commit.
//
//   node bot/publish.mjs              render, commit, push
//   node bot/publish.mjs --no-push    render and commit only
//   node bot/publish.mjs --preview    render only

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadMatches } from './matches.mjs'
import { inject, section } from './page.mjs'
import { kstToday } from './lib/time.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PAGE = fileURLToPath(new URL('../docs/index.html', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

export function render ({ now = new Date() } = {}) {
    const before = readFileSync(PAGE, 'utf8')
    // The "checked" time changes every run; compare without it, so an unchanged schedule is no change.
    const after = inject(before, section(loadMatches(), { today: kstToday(now), now }))
    const strip = (html) => html.replace(/checked \d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+/, '')
    return { changed: strip(before) !== strip(after), html: after }
}

export function publish ({ push = true, commit = true, now = new Date() } = {}) {
    const { changed, html } = render({ now })
    if (!changed) return { changed: false }
    writeFileSync(PAGE, html)
    if (!commit) return { changed: true, committed: false }
    git('add', 'docs/index.html', 'bot/data/matches.json', 'bot/data/names.json')
    git('commit', '-q', '-m', `Skim Bot: schedule as of ${kstToday(now)} KST`)
    if (!push) return { changed: true, committed: true, pushed: false }
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') return { changed: true, committed: true, pushed: false, why: 'not on main' }
    git('push', '-q', 'origin', 'main')
    return { changed: true, committed: true, pushed: true }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    if (process.argv.includes('--preview')) {
        const { changed, html } = render()
        writeFileSync(PAGE, html)
        console.log(changed ? 'Rendered (not committed).' : 'No change.')
    } else console.log(JSON.stringify(publish({ push: !process.argv.includes('--no-push') })))
}
