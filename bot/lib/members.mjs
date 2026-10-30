// Group members -> the IDs the group knows them by, so a reply names "Ryko[SkiM]", never a
// phone number (Silviu, 30 Oct).
//
// members.json is the table, kept OUT of the repository (.gitignore): the repo has a GitHub
// remote and personal numbers do not belong there. members.example.json shows its shape. A
// number matches in any form the bridge gives (+40 700 000 001, 40700000001, 0700000001,
// 40700000001@c.us); a number not in the table, or anything that is not a number, is shown
// as it came.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MEMBERS_FILE = fileURLToPath(new URL('../data/members.json', import.meta.url))

// One form for every way of writing a Romanian number: its digits with the country code.
export function phoneKey (text) {
    const raw = String(text ?? '').split('@')[0]
    if (!/^[\s+()\-.\d]+$/.test(raw)) return null
    let digits = raw.replace(/\D/g, '')
    if (digits.startsWith('00')) digits = digits.slice(2)
    if (/^0\d{9}$/.test(digits)) digits = '40' + digits.slice(1)
    else if (/^7\d{8}$/.test(digits)) digits = '40' + digits
    return digits.length >= 8 ? digits : null
}

export function loadMembers (file = MEMBERS_FILE) {
    let table
    try { table = JSON.parse(readFileSync(file, 'utf8')) } catch { return new Map() }
    return new Map(Object.entries(table).map(([number, id]) => [phoneKey(number), id]).filter(([key]) => key))
}

export function memberName (from, members = loadMembers()) {
    const key = phoneKey(from)
    return (key && members.get(key)) || from
}
