// Korean star-university words -> English, for titles on EloBoard's schedule (F-238). Team
// names follow the SkiM page and the calendar's own earlier entries (마범대 = MBU). Whatever a
// title still holds in Korean after this waits for the model run to translate it; nothing in
// Korean reaches the page, the calendar or the group.

export const TEAMS = [
    ['캄몬스타즈', 'Calm MonstarZ'], ['캄몬', 'Calm MonstarZ'], ['드림즈', 'Dreamz'], ['신세계', 'New World'], ['뉴캣슬', 'New Castle'],
    ['케이대', 'K University'], ['흑카데미', 'Black Academy'], ['엠비대', 'MB University'], ['마범대', 'MBU'], ['더블비', 'Double B'],
    ['와플대', 'Waffle University'], ['연합팀', 'United Team'], ['더케이', 'The K'],
]

export const PHRASES = [
    [/\[중계진\]\s?/g, ''],
    [/미니\s?대학\s?대전|미니\s?대전/g, 'Mini-Match'], [/대학\s?대전/g, 'University Clash'], [/스페셜\s?끝장전/g, 'Special Ultimate Battle'],
    [/끝장전/g, 'Ultimate Battle'], [/교수\s?ck/gi, "Professors' CK"], [/유스\s?종족\s?최강자전/g, 'Youth Race Championship'],
    [/종족\s?최강자전/g, 'Race Championship'], [/마범컵/g, 'Ma Beom Cup'], [/(\d)\s?,\s?(\d)\s?티어\s?대회/g, 'Tier $1–$2 Tournament'],
    [/티어\s?대회/g, 'Tier Tournament'], [/실력\s?점검/g, 'Skill Check'], [/스타\s?여캠/g, "Women streamers'"], [/중계/g, 'cast'],
    [/\s?개최$/g, ''], [/Google Play\s?/g, ''],
]

export const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/

export function translateTitle (title) {
    let out = String(title || '')
    for (const [re, en] of PHRASES) out = out.replace(re, en)
    for (const [ko, en] of TEAMS) out = out.replaceAll(ko, en)
    return out.replace(/\bVS\b/g, 'vs').replace(/\[\s*([^\]]+?)\s*\]/g, '[$1]').replace(/\s+/g, ' ').trim()
}
