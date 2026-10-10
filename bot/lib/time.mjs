// Times for SkiM SC: every match is announced in KST (UTC+9, no daylight saving) and shown
// in KST and Bucharest time. Bucharest is worked out with the time zone database, so the
// switch from EEST to EET (25 October 2026) needs nobody to remember it.

export const KST_OFFSET_MS = 9 * 3600 * 1000

// "2026-10-17" + "15:00" in Seoul -> the instant.
export function kstInstant (date, hhmm) {
    const [y, m, d] = date.split('-').map(Number)
    const [h, min] = hhmm.split(':').map(Number)
    return new Date(Date.UTC(y, m - 1, d, h, min) - KST_OFFSET_MS)
}

export function inZone (instant, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).formatToParts(instant).map((p) => [p.type, p.value]))
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, zone: parts.timeZoneName }
}

// Bucharest's own name for its offset, which Intl gives as GMT+3 / GMT+2.
export function bucharest (instant) {
    const t = inZone(instant, 'Europe/Bucharest')
    return { ...t, zone: t.zone === 'GMT+3' ? 'EEST' : t.zone === 'GMT+2' ? 'EET' : t.zone }
}

export const kstToday = (now = new Date()) => inZone(now, 'Asia/Seoul').date
