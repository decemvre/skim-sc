import test from 'node:test'
import assert from 'node:assert/strict'

import { ask, overLimit, questionOf, replyText, LIMITS } from '../ask.mjs'
import { send } from '../post.mjs'

const NOW = new Date('2026-10-16T20:00:00Z') // 23:00 in Bucharest: outside the posting window

test('the question is what follows /skim or @skim', () => {
    assert.equal(questionOf('/skim cine joacă azi?'), 'cine joacă azi?')
    assert.equal(questionOf('@Skim: who won?'), 'who won?')
    assert.equal(questionOf('/skim'), '')
})

test('the reply says who asked, then the answer, then each link alone on its own line', () => {
    const text = replyText('Silviu', 'cine joacă?', { answer: 'Rush și Light.', links: ['https://a.example/1', 'not a link', 'https://b.example/2', 'https://c.example/3'] })
    assert.equal(text, '❓ Silviu: cine joacă?\n\nRush și Light.\n\nhttps://a.example/1\n\nhttps://b.example/2')
})

test('an answer goes at any hour, scores included, and a message is answered once', async () => {
    const sent = []
    const asked = {}
    const fetchImpl = async (url, { body }) => { sent.push(JSON.parse(body)); return { ok: true, json: async () => ({ sent: true }) } }
    const sender = (text, options) => send(text, { ...options, group: 'Noobz', fetchImpl, now: NOW })
    const model = async () => ({ language: 'en', answer: 'Rush beat Light 3-1.', links: [] })
    await ask({ id: 'm1', from: 'Andrei', text: '/skim who won?', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /Rush beat Light 3-1/)
    assert.equal(sent[0].agent, 'skim')
    const again = await ask({ id: 'm1', from: 'Andrei', text: '/skim who won?', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(again.skipped, 'already answered')
    assert.equal(sent.length, 1)
})

test('a failed search still answers, in the language it was asked in', async () => {
    let posted
    const model = async () => { throw new Error('down') }
    await ask({ text: '/skim când e finala?', now: NOW, asked: {}, save: () => {}, model, sender: async (t) => { posted = t; return { sent: true } } })
    assert.match(posted, /Nu am putut căuta acum/)
})

test('the group cannot run it in a loop', () => {
    const asked = Object.fromEntries(Array.from({ length: LIMITS.hour }, (_, i) => [`m${i}`, { at: new Date(NOW - i * 60e3).toISOString() }]))
    assert.equal(overLimit(asked, NOW), 'hour')
    assert.equal(overLimit({}, NOW), null)
})

test('over the limit, the first question hears it once, in its language; the next waits quietly', async () => {
    const asked = Object.fromEntries(Array.from({ length: LIMITS.hour }, (_, i) => [`m${i}`, { at: new Date(NOW - i * 60e3).toISOString() }]))
    const posted = []
    const sender = async (t) => { posted.push(t); return { sent: true } }
    const model = async () => { throw new Error('not asked') }
    await ask({ id: 'x1', text: '/skim cine joacă?', now: NOW, asked, save: () => {}, model, sender })
    await ask({ id: 'x2', text: '/skim who plays?', now: NOW, asked, save: () => {}, model, sender })
    assert.equal(posted.length, 1)
    assert.match(posted[0], /Am răspuns la 15 întrebări în ultima oră/)
})
