import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadMembers, memberName, phoneKey } from '../lib/members.mjs'
import { noLinkAboveText } from '../ask.mjs'

const table = () => {
    const file = join(mkdtempSync(join(tmpdir(), 'members-')), 'members.json')
    writeFileSync(file, JSON.stringify({ '+40 700 000 001': 'Name[SkiM]', '+40 700 000 002': 'Other[SkiM]' }))
    return loadMembers(file)
}

test('a member is named by their ID in every form the bridge writes the number', () => {
    const members = table()
    for (const from of ['+40 700 000 001', '+40700000001', '40700000001', '0700 000 001', '0700000001', '0040 700 000 001',
        '700000001', '40700000001@c.us', '+40 (700) 000-001']) assert.equal(memberName(from, members), 'Name[SkiM]', from)
    assert.equal(memberName('+40 700 000 002', members), 'Other[SkiM]')
})

test('an unknown number, a name or nothing is shown as it came', () => {
    const members = table()
    for (const from of ['+40 799 999 999', '+44 7700 900123', 'Andrei', '', undefined]) assert.equal(memberName(from, members), from)
    assert.equal(phoneKey('Andrei 0700000001'), null)
})

test('a missing table names nobody, it never fails', () => {
    assert.equal(memberName('+40 700 000 001', loadMembers('/nonexistent/members.json')), '+40 700 000 001')
})

test('the reply names the member by ID', () => {
    assert.equal(noLinkAboveText(memberName('40700000001', table())), '🎬 Name[SkiM]: I found no YouTube link above your /skim yt.')
})

test('the example table has the shape of the real one, with no real number in it', async () => {
    const example = loadMembers(new URL('../data/members.example.json', import.meta.url).pathname)
    assert.ok(example.size > 0)
    for (const key of example.keys()) assert.match(key, /^40700000/)
})
