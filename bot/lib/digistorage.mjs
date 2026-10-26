// Digi Cloud (DigiStorage, storage.rcs-rds.ro), F-535: the few things Skim Bot needs to put a
// video in a folder and hand out a link to it, through rclone's koofr backend (provider
// "digistorage" - DigiStorage runs Koofr). rclone is the user-local ~/.local/bin/rclone.
//
// Login: ~/.config/digistorage/skim-bot, mode 600 - line 1 the Digi Cloud email, line 2 an app
// password made for Skim Bot (F-536), never the account's own. It goes to rclone obscured, in its
// environment, never on a command line, and is never printed.
//
// Only FOLDER is ever written to; nothing else in the account is listed, moved or deleted.
// A link is Koofr's public link: whoever has the URL can open the file without logging in; it is
// listed nowhere and nothing on it is indexed - the URL is the whole secret. Digi Cloud gives a new
// link a password and 14 days by default (seen 26 Oct): the password is taken off here, through
// Koofr's REST API (rclone cannot), and the 14 days stay - a link nearly out is made again.

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CREDENTIALS_FILE = process.env.DIGISTORAGE_CREDENTIALS || join(homedir(), '.config/digistorage/skim-bot')
export const RCLONE = process.env.RCLONE || join(homedir(), '.local/bin/rclone')
export const FOLDER = '/Skim videos'
export const BASE = process.env.DIGISTORAGE_URL || 'https://storage.rcs-rds.ro'

export class MissingCredentials extends Error {}

export function credentials (file = CREDENTIALS_FILE) {
    let lines
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()) } catch { throw new MissingCredentials(`no Digi Cloud login: ${file} is missing`) }
    const [user, password] = lines
    if (!user || !password) throw new MissingCredentials(`no Digi Cloud login: ${file} needs the email on line 1 and the app password on line 2`)
    if (statSync(file).mode & 0o077) console.error(`digistorage: ${file} is readable by others - chmod 600 it`)
    return { user, password }
}

const remote = (path) => `:koofr:${String(path).replace(/^\/+/, '')}`

function exec (cmd, args, { env, input, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (!error) return resolve(stdout)
            const last = String(stderr || error.message).trim().split('\n').slice(-1)[0]
            const E = /401|403|unauthori[sz]ed|invalid credentials|authentication/i.test(last) ? MissingCredentials : Error
            reject(Object.assign(new E(`rclone ${args[0]}: ${last.replace(/^.*?(ERROR|NOTICE)\s*:\s*/, '').slice(0, 200)}`), { code: error.code }))
        })
        if (input !== undefined) child.stdin.end(input)
    })
}

export class Digi {
    constructor ({ creds = null, runner = exec, rclone = RCLONE, fetchImpl = fetch, base = BASE } = {}) {
        Object.assign(this, { creds, runner, rclone, fetchImpl, base })
        this.env = null
        this.mountId = null
    }

    // Koofr's REST API, for what rclone cannot do with a link.
    async api (method, path) {
        const { user, password } = this.creds ||= credentials()
        const r = await this.fetchImpl(new URL(path, this.base), { method, signal: AbortSignal.timeout(60000),
            headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64'), Accept: 'application/json' } })
        if (r.status === 401 || r.status === 403) throw new MissingCredentials(`Digi Cloud refused the login (${r.status})`)
        if (!r.ok) throw new Error(`Digi Cloud ${method} ${path.replace(/[0-9a-f-]{36}/g, '…')}: ${r.status}`)
        const text = await r.text()
        return text ? JSON.parse(text) : {}
    }

    async mount () {
        if (this.mountId) return this.mountId
        const { mounts = [] } = await this.api('GET', '/api/v2/mounts')
        const m = mounts.find((x) => x.isPrimary)
        if (!m) throw new Error('Digi Cloud: no drive found')
        return (this.mountId = m.id)
    }

    async linksTo (path) {
        const { links = [] } = await this.api('GET', `/api/v2/mounts/${await this.mount()}/links`)
        return links.filter((l) => l.path === path)
    }

    // rclone's environment: the backend and the login, the password obscured by rclone itself.
    async environment () {
        if (this.env) return this.env
        const { user, password } = this.creds ||= credentials()
        const obscured = (await this.runner(this.rclone, ['obscure', '-'], { input: password })).trim()
        this.env = { ...process.env, RCLONE_CONFIG: '/nonexistent/skim-bot-rclone.conf', RCLONE_KOOFR_PROVIDER: 'digistorage',
            RCLONE_KOOFR_USER: user, RCLONE_KOOFR_PASSWORD: obscured, RCLONE_KOOFR_SETMTIME: 'false' }
        return this.env
    }

    async rc (args, timeout) {
        return this.runner(this.rclone, args, { env: await this.environment(), timeout })
    }

    // {size, modified} of a path, or null when there is nothing there.
    async info (path) {
        try {
            const s = JSON.parse(await this.rc(['lsjson', '--stat', remote(path)]))
            return { type: s.IsDir ? 'dir' : 'file', size: s.Size, modified: Date.parse(s.ModTime) }
        } catch (error) {
            if (/not found|doesn't exist|no such/i.test(error.message)) return null
            throw error
        }
    }

    async ensureFolder (path = FOLDER) {
        await this.rc(['mkdir', remote(path)])
    }

    // Free space in bytes, or null when the drive does not say.
    async free () {
        try { const a = JSON.parse(await this.rc(['about', '--json', remote('')])); return Number.isFinite(a.free) ? a.free : null } catch { return null }
    }

    // One file into `dir` under `name`. Idempotent: a file already there of the same size is not
    // sent again.
    async upload (file, { dir = FOLDER, name }) {
        const path = `${dir}/${name}`
        await this.rc(['copyto', '--size-only', '--retries', '1', '--low-level-retries', '3', file, remote(path)], 3 * 3600e3)
        return { path }
    }

    // A new link to one file, without a password: {url, validTo}. The url is the link's own page
    // (storage.rcs-rds.ro/links/<id>), with the file's name, a preview and a download button.
    async link (path) {
        const made = (await this.rc(['link', remote(path)])).trim().split('\n').pop()
        const id = made.match(/\/links\/([0-9a-f-]{36})/)?.[1]
        if (!id) throw new Error('Digi Cloud made a link without a URL')
        const at = `/api/v2/mounts/${await this.mount()}/links/${id}`
        await this.api('DELETE', `${at}/password`)
        const l = await this.api('GET', at)
        if (l.hasPassword) throw new Error('Digi Cloud kept a password on the link')
        if (!/^https:\/\/\S+$/.test(l.url || '')) throw new Error('Digi Cloud made a link without a URL')
        return { url: l.url, validTo: l.validTo || null }
    }

    // Every link to a path, gone.
    async unlink (path) {
        const m = await this.mount()
        for (const l of await this.linksTo(path)) await this.api('DELETE', `/api/v2/mounts/${m}/links/${l.id}`)
    }

    // A path inside FOLDER, by name - the only kind this ever deletes.
    static inFolder (path, dir = FOLDER) {
        const rest = String(path).startsWith(dir + '/') ? path.slice(dir.length + 1) : ''
        return Boolean(rest) && !rest.includes('/') && rest !== '.' && rest !== '..'
    }

    // At most `keep` files in FOLDER (Silviu, 26 Oct: 20): the oldest by upload time go, each with
    // its link. Returns the paths deleted. Nothing outside FOLDER is looked at.
    async prune (keep, dir = FOLDER) {
        const files = JSON.parse(await this.rc(['lsjson', '--files-only', '--no-mimetype', remote(dir)]))
        const old = files.sort((a, b) => Date.parse(b.ModTime) - Date.parse(a.ModTime)).slice(keep)
        const gone = []
        for (const f of old) {
            const path = `${dir}/${f.Name}`
            if (!Digi.inFolder(path, dir)) continue
            await this.unlink(path)
            await this.rc(['deletefile', remote(path)])
            gone.push(path)
        }
        return gone
    }
}
