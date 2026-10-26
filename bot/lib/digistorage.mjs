// Digi Cloud (DigiStorage, storage.rcs-rds.ro), F-535: the few calls Skim Bot needs to put a
// video in a folder and hand out a link to it. DigiStorage runs Koofr; this is Koofr's REST API,
// the same one rclone's koofr backend speaks (provider "digistorage").
//
// Credentials: ~/.config/friendzy/digistorage.json, mode 600,
//   {"user": "<the Digi Cloud login email>", "password": "<an app password made for Skim Bot>"}
// An app password (Digi Cloud > Settings > Password > App passwords), never the account's own:
// it can be revoked on its own and it is what the API accepts with basic auth.
//
// Only FOLDER is ever written to; nothing else in the account is listed, moved or deleted.
// A link is Koofr's "public link": whoever has the URL can open the file, without logging in.
// It is not listed anywhere and nothing on the page is indexed - the URL is the whole secret.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BASE = process.env.DIGISTORAGE_URL || 'https://storage.rcs-rds.ro'
export const CREDENTIALS_FILE = process.env.DIGISTORAGE_CREDENTIALS || join(homedir(), '.config/friendzy/digistorage.json')
export const FOLDER = '/Skim videos'

export class MissingCredentials extends Error {}

export function credentials (file = CREDENTIALS_FILE) {
    let c
    try { c = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new MissingCredentials(`no Digi Cloud login: ${file} is missing`) }
    if (!c.user || !c.password) throw new MissingCredentials(`no Digi Cloud login: ${file} needs "user" and "password"`)
    return c
}

export class Digi {
    constructor ({ creds = credentials(), fetchImpl = fetch, base = BASE } = {}) {
        this.base = base
        this.fetch = fetchImpl
        this.auth = 'Basic ' + Buffer.from(`${creds.user}:${creds.password}`).toString('base64')
        this.mountId = null
    }

    async call (method, path, { query, json, body, headers = {}, ok404 = false, timeout = 60000 } = {}) {
        const url = new URL(path, this.base)
        for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v)
        const r = await this.fetch(url, {
            method,
            headers: { Authorization: this.auth, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: json ? JSON.stringify(json) : body,
            signal: AbortSignal.timeout(timeout),
            ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {}),
        })
        if (ok404 && r.status === 404) return null
        if (r.status === 401 || r.status === 403) throw new MissingCredentials(`Digi Cloud refused the login (${r.status})`)
        if (!r.ok) throw new Error(`Digi Cloud ${method} ${url.pathname}: ${r.status}`)
        const text = await r.text()
        return text ? JSON.parse(text) : {}
    }

    // The account's own drive ("Digi Cloud"), not a shared or connected one.
    async mount () {
        if (this.mountId) return this.mountId
        const { mounts = [] } = await this.call('GET', '/api/v2/mounts')
        const m = mounts.find((x) => x.isPrimary) || mounts.find((x) => x.type === 'device')
        if (!m) throw new Error('Digi Cloud: no drive found')
        this.mountId = m.id
        this.space = { total: m.spaceTotal, used: m.spaceUsed } // in MB
        return m.id
    }

    async info (path) {
        return this.call('GET', `/api/v2/mounts/${await this.mount()}/files/info`, { query: { path }, ok404: true })
    }

    // FOLDER, made the first time. Only ever at the root, by its own name.
    async ensureFolder (path = FOLDER) {
        const found = await this.info(path)
        if (found) { if (found.type !== 'dir') throw new Error(`Digi Cloud: ${path} is not a folder`); return }
        const name = path.replace(/^\/+/, '')
        await this.call('POST', `/api/v2/mounts/${await this.mount()}/files/folder`, { query: { path: '/' }, json: { name } })
    }

    // Free space in bytes, or null when the drive does not say.
    async free () {
        await this.mount()
        const { total, used } = this.space || {}
        return Number.isFinite(total) && Number.isFinite(used) ? (total - used) * 1024 * 1024 : null
    }

    // Upload one file into `dir` under `name`. Idempotent: a file already there with the same
    // size is the same upload finished before, and is not sent again.
    async upload (file, { dir = FOLDER, name, size, open }) {
        const path = `${dir}/${name}`
        const there = await this.info(path)
        if (there && there.type === 'file' && there.size === size) return { path, reused: true }
        const form = new FormData()
        form.append('file', await open(), name)
        const r = await this.call('POST', `/content/api/v2/mounts/${await this.mount()}/files/put`, {
            query: { path: dir, filename: name, info: 'true', overwrite: 'true' }, body: form, timeout: 60 * 60000,
        })
        return { path: dir + '/' + (r?.name || name), reused: false }
    }

    // A path inside FOLDER, by name - the only kind this ever deletes.
    static inFolder (path, dir = FOLDER) {
        const rest = String(path).startsWith(dir + '/') ? path.slice(dir.length + 1) : ''
        return Boolean(rest) && !rest.includes('/') && rest !== '.' && rest !== '..'
    }

    // At most `keep` files in FOLDER (Silviu, 26 Oct: 20): the oldest by upload time go, each
    // with its links. Returns the paths deleted. Nothing outside FOLDER is looked at.
    async prune (keep, dir = FOLDER) {
        const id = await this.mount()
        const { files = [] } = await this.call('GET', `/api/v2/mounts/${id}/files/list`, { query: { path: dir } })
        const old = files.filter((f) => f.type === 'file').sort((a, b) => b.modified - a.modified).slice(keep)
        if (!old.length) return []
        const { links = [] } = await this.call('GET', `/api/v2/mounts/${id}/links`)
        const gone = []
        for (const f of old) {
            const path = `${dir}/${f.name}`
            if (!Digi.inFolder(path, dir)) continue
            for (const l of links.filter((x) => x.path === path)) await this.call('DELETE', `/api/v2/mounts/${id}/links/${encodeURIComponent(l.id)}`)
            await this.call('DELETE', `/api/v2/mounts/${id}/files/remove`, { query: { path } })
            gone.push(path)
        }
        return gone
    }

    // The link to one file: the one made before for this path, or a new one.
    async link (path) {
        const id = await this.mount()
        const { links = [] } = await this.call('GET', `/api/v2/mounts/${id}/links`)
        const old = links.find((l) => l.path === path && !l.hasPassword)
        const l = old || await this.call('POST', `/api/v2/mounts/${id}/links`, { json: { path } })
        const url = l.shortUrl || l.url
        if (!/^https:\/\//.test(url || '')) throw new Error('Digi Cloud made a link without a URL')
        return { url, reused: Boolean(old) }
    }
}
