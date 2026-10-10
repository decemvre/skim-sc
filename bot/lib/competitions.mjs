// Competition names as SOOP writes them -> what we call them, and how much they matter to us.
// `big` competitions get a reminder before their headline matches (F-236). A name not here is
// shown as SOOP writes it and listed in the run's report for a human to add.

export const COMPETITIONS = [
    { match: /ASL/i, name: (s) => s.replace(/^Google Play\s+/i, '').replace(/Season\s*(\d+)/i, 'Season $1'), big: true, watch: 'https://www.sooplive.com/station/afstar1',
        liquipedia: (s) => /Season\s*(\d+)/i.exec(s) ? `ASL/${/Season\s*(\d+)/i.exec(s)[1]}` : null },
    { match: /스타끝장전/, name: () => 'Ultimate Battle', big: true, watch: 'https://www.sooplive.com/station/talent' },
    { match: /연예인\s*스타리그/, name: (s) => `Celebrity StarLeague${/시즌\s*(\d+)/.exec(s) ? ' Season ' + /시즌\s*(\d+)/.exec(s)[1] : ''}`, big: false, celebrity: true },
    { match: /SSL|스타리그/, name: (s) => s, big: true },
    { match: /KCM/i, name: (s) => s, big: false, watch: 'https://www.sooplive.com/station/cjfals28' },
    { match: /K-?정맨|정맨/, name: () => 'K-Jungman Cup', big: false },
    { match: /대학|university/i, name: (s) => s, big: false },
]

export function competition (raw) {
    const known = COMPETITIONS.find((c) => c.match.test(raw))
    return known ? { name: known.name(raw), big: known.big, celebrity: Boolean(known.celebrity), watch: known.watch || null, known: true,
        liquipedia: known.liquipedia ? known.liquipedia(raw) : null }
        : { name: raw, big: false, celebrity: false, watch: null, known: false, liquipedia: null }
}
