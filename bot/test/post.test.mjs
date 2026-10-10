import test from 'node:test';
import assert from 'node:assert/strict';

import {competition} from '../lib/competitions.mjs';
import {blurb, dueReminders, newsBlock, newsText, freshCards, inWindow, morningText, post, safe, send} from '../post.mjs';

// F-236: the group posts. Nothing on a quiet day, never a result, links on their own line.
const m = (over) => ({key: 'k1', date: '2026-10-17', kst: '15:00', at: '2026-10-17T06:00:00.000Z', bucharest: {time: '09:00', zone: 'EEST'},
    competition: {name: 'ASL Season 22', big: true, watch: 'https://www.sooplive.com/station/afstar1'}, a: {id: 'Rush', race: 'T'}, b: {id: 'Soulkey', race: 'Z'},
    played: false, onSchedule: true, ...over});

test('morning: only on a day with matches or news; celebrity leagues and team-only matches left out', () => {
    assert.equal(morningText([m({date: '2026-10-18'})], [], '2026-10-17'), null);
    assert.equal(morningText([m({competition: {name: 'Celebrity', celebrity: true}})], [], '2026-10-17'), null);
    const text = morningText([m({})], [], '2026-10-17');
    assert.match(text, /ASL S22: Rush \(T\) vs Soulkey \(Z\)\n15:00 KST · 09:00 Bucharest/);
    for (const line of text.split('\n').filter((l) => /https?:/.test(l))) assert.match(line, /^https?:\/\/\S+$/, 'a link alone on its line');
    const lines = text.split('\n');
    lines.forEach((l, i) => { if (/^https?:/.test(l)) { assert.equal(lines[i - 1], ''); assert.ok(lines[i + 1] === '' || lines[i + 1] === undefined); } });
});

test('no card that looks like a result, none irrelevant, none older than five days, none twice', () => {
    const at = '2026-10-16T10:00:00Z';
    const news = {items: [
        {id: 'a', addedAt: at, relevant: true, card: 'Both finalists talk before Saturday'},
        {id: 'b', addedAt: at, relevant: true, card: 'Rush beats Light 4-2'},
        {id: 'c', addedAt: '2026-10-01T10:00:00Z', relevant: true, card: 'Old news'},
        {id: 'd', addedAt: at, relevant: true, card: null},
        {id: 'e', addedAt: at, relevant: true, card: 'Already posted'},
        {id: 'f', addedAt: at, relevant: false, card: 'A small online cup'},
    ]};
    assert.deepEqual(freshCards(news, {news: {e: 'x'}}, new Date('2026-10-17T06:00:00Z')).map((c) => c.id), ['a']);
    assert.equal(newsText([]), null);
    assert.equal(safe('Rush won the final\n15:00 KST · 09:00 Bucharest\nnice'), '15:00 KST · 09:00 Bucharest\nnice');
});

test('a reminder half an hour before a big match, once', async () => {
    const list = [m({}), m({key: 'k2', competition: {name: 'Ultimate Battle', big: false}})];
    assert.deepEqual(dueReminders(list, {reminders: {}}, new Date('2026-10-17T05:35:00Z')).map((x) => x.key), ['k1']);
    assert.deepEqual(dueReminders(list, {reminders: {}}, new Date('2026-10-17T04:00:00Z')), [], 'too early');
    const sent = [];
    const posted = {mornings: {}, reminders: {}, news: {}};
    const sender = async (text) => { sent.push(text); return {sent: true, status: 'delivered'}; };
    await post('reminders', {now: new Date('2026-10-17T05:35:00Z'), posted, matches: list, news: {items: []}, sender});
    await post('reminders', {now: new Date('2026-10-17T05:40:00Z'), posted, matches: list, news: {items: []}, sender});
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^🤖 Starting in 25 minutes/);
});

test('the window: nothing before 08:00 or from 16:00 Bucharest, whatever asks', async () => {
    assert.equal(inWindow(new Date('2026-10-12T04:59:00Z')), false, '07:59 EEST');
    assert.equal(inWindow(new Date('2026-10-12T05:00:00Z')), true, '08:00 EEST');
    assert.equal(inWindow(new Date('2026-10-12T12:59:00Z')), true, '15:59 EEST');
    assert.equal(inWindow(new Date('2026-10-12T13:00:00Z')), false, '16:00 EEST');
    assert.equal(inWindow(new Date('2026-10-26T06:30:00Z')), true, '08:30 EET, after the clocks change');
    await assert.rejects(send('hi', {group: 'g', now: new Date('2026-10-12T20:00:00Z'), fetchImpl: async () => { throw new Error('must not be called'); }}), /outside 08:00-16:00/);
    const sent = [];
    const r = await post('reminders', {now: new Date('2026-10-12T03:00:00Z'), posted: {mornings: {}, reminders: {}, news: {}},
        matches: [m({date: '2026-10-12', at: '2026-10-12T03:30:00.000Z'})], news: {items: []}, sender: async (t) => { sent.push(t); return {sent: true}; }});
    assert.deepEqual(sent, [], 'a reminder due at 06:00 is not sent');
    assert.equal(r.results.length, 0);
});

test('weekdays: one morning post, then news as it comes; later news waits for the next morning', async () => {
    const sent = [];
    const posted = {mornings: {}, reminders: {}, news: {}};
    const sender = async (text) => { sent.push(text); return {sent: true}; };
    const news = {items: [{id: 'a', addedAt: '2026-10-12T05:00:00Z', relevant: true, card: 'Finalists talk'}]};
    const mon8 = new Date('2026-10-12T05:00:00Z');
    await post('news', {now: mon8, posted, matches: [], news, sender});
    assert.equal(sent.length, 0, 'no news before the morning post');
    await post('morning', {now: mon8, posted, matches: [m({date: '2026-10-12'})], news, sender});
    await post('morning', {now: mon8, posted, matches: [m({date: '2026-10-12'})], news, sender});
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Finalists talk/);
    news.items.push({id: 'b', addedAt: '2026-10-12T09:00:00Z', relevant: true, card: 'A new star university joins'});
    await post('news', {now: new Date('2026-10-12T09:05:00Z'), posted, matches: [], news, sender});
    assert.equal(sent.length, 2);
    assert.match(sent[1], /^🤖 Skim Bot - Brood War news/);
    news.items.push({id: 'c', addedAt: '2026-10-12T15:00:00Z', relevant: true, card: 'Evening announcement'});
    await post('news', {now: new Date('2026-10-12T15:05:00Z'), posted, matches: [], news, sender});
    assert.equal(sent.length, 2, '18:05 is outside the window');
    await post('morning', {now: new Date('2026-10-13T05:00:00Z'), posted, matches: [], news, sender});
    assert.equal(sent.length, 3);
    assert.match(sent[2], /Evening announcement/);
});

test('weekends: no news at all; the morning post only for a major match', async () => {
    const sent = [];
    const posted = {mornings: {}, reminders: {}, news: {}};
    const sender = async (text) => { sent.push(text); return {sent: true}; };
    const news = {items: [{id: 'a', addedAt: '2026-10-17T05:00:00Z', relevant: true, card: 'Saturday news'}]};
    const sat8 = new Date('2026-10-17T05:00:00Z');
    await post('morning', {now: sat8, posted, matches: [m({competition: {name: 'Ultimate Battle', big: false}})], news, sender});
    assert.equal(sent.length, 0, 'a minor match and news: nothing on a Saturday');
    const posted2 = {mornings: {}, reminders: {}, news: {}};
    await post('morning', {now: sat8, posted: posted2, matches: [m({})], news, sender});
    await post('news', {now: new Date('2026-10-17T08:00:00Z'), posted: posted2, matches: [], news, sender});
    assert.equal(sent.length, 1);
    assert.match(sent[0], /ASL S22: Rush/);
    assert.doesNotMatch(sent[0], /Saturday news/);
});

test('news in the chat: a bold title with a short spoiler-free summary under it; TL.net is not Korean news', () => {
    assert.equal(newsBlock({card: 'ASL S22 final set for Saturday', teaser: 'Both finalists talk about the ice-rink stage.'}), '*ASL S22 final set for Saturday*\nBoth finalists talk about the ice-rink stage.');
    assert.equal(blurb({spoiler: false, summary: 'EloBoard added an FA tab. More text.'}), 'EloBoard added an FA tab.');
    assert.equal(blurb({spoiler: true, summary: 'Bisu beat Speed 4-2.'}), '', 'a spoiler without a teaser gets no summary');
    assert.equal(blurb({teaser: 'Rush won 4-2.'}), '', 'a teaser that gives a result away is dropped');
    const at = '2026-10-12T05:00:00Z';
    assert.deepEqual(freshCards({items: [{id: 'tl', addedAt: at, card: 'Rollback thread', sources: ['https://tl.net/forum/x']}]}, {news: {}}, new Date('2026-10-12T06:00:00Z')), []);
});

test('Ultimate Battle is a big competition: it gets the reminder', () => {
    assert.equal(competition('스타끝장전 시즌3').big, true);
});
