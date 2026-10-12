// Liquipedia's Brood War wiki, asked politely: its API terms want a User-Agent that says who
// is asking, gzip, and no more than one request every two seconds. Everything asked is cached
// by the caller (names.json), so a name is looked up once, ever.

const API = 'https://liquipedia.net/starcraft/api.php'
export const USER_AGENT = 'SkimSCBot/1.0 (https://decemvre.github.io/skim-sc/; a fan guide)'
const GAP_MS = 2100
let last = 0

export async function ask (params, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const wait = last + GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    last = Date.now()
    const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`
    const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Liquipedia answered ${response.status}`)
    return response.json()
}

export async function search (text, options) {
    const d = await ask({ action: 'query', list: 'search', srsearch: `"${text}"`, srlimit: '5' }, options)
    return (d.query?.search || []).map((r) => r.title)
}

export async function wikitext (title, options) {
    const d = await ask({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title, redirects: '1' }, options)
    const page = Object.values(d.query?.pages || {})[0]
    return page?.revisions?.[0]?.slots?.main?.['*'] || null
}

// The fields of a player's infobox that matter to us.
export function infobox (text) {
    const box = /\{\{Infobox player([\s\S]*?)\n\}\}/.exec(text || '')?.[1]
    if (!box) return null
    const field = (name) => new RegExp(`\\n\\|${name}=([^\\n]*)`).exec(box)?.[1]?.trim() || ''
    return { id: field('id'), name: field('name'), romanized: field('romanized_name'), race: field('race'),
        nicknames: field('nicknames').split(',').map((n) => n.trim()).filter(Boolean), afreeca: field('afreeca') }
}
