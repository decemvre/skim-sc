// Skim Bot: which news may go to the group (Silviu, 12 Oct - "too much news"). Only stories about
// one of the top ~30 players in the watchlist, the ASL, Race Wars or the Major Proleague. Checked
// here on the finished English text, after the IDs are filled in, so a story the model called
// relevant still has to name one of them to be posted. The page keeps every story.

const EVENTS = /\bASL\b|Afreeca(?:TV)? Star(?:craft)? League|\bRace ?Wars?\b|\bMajor Pro ?League\b/i

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function inScope (item, watchlist) {
    // The title and the card say what a story is about; the summary names everyone in passing
    // ("trained the Action way", a line-up, a teacher), which is not the story being about them.
    const text = [item.card, item.headline].filter(Boolean).join(' ')
    if (EVENTS.test(text)) return true
    // By ID, as written: "Light" the player, not "light" the word.
    return (watchlist?.players || []).some((p) => p.id && new RegExp(`(^|[^A-Za-z0-9])${escape(p.id)}(?![A-Za-z0-9])`).test(text))
}
