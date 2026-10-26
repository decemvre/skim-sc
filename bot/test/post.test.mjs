import test from 'node:test';
import assert from 'node:assert/strict';

import {competition} from '../lib/competitions.mjs';
import {UnsureError, blurb, freshResults, dueReminders, newsBlock, newsText, freshCards, inWindow, morningText, post, safe, send} from '../post.mjs';

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
        {id: 'a', addedAt: at, headline: 'ASL S22', relevant: true, card: 'Both finalists talk before Saturday'},
        {id: 'b', addedAt: at, headline: 'ASL S22', relevant: true, card: 'Rush beats Light 4-2'},
        {id: 'c', addedAt: '2026-10-01T10:00:00Z', headline: 'ASL S22', relevant: true, card: 'Old news'},
        {id: 'd', addedAt: at, headline: 'ASL S22', relevant: true, card: null},
        {id: 'e', addedAt: at, headline: 'ASL S22', relevant: true, card: 'Already posted'},
        {id: 'f', addedAt: at, relevant: false, card: 'A small online cup'},
    ]};
    assert.deepEqual(freshCards(news, {news: {e: 'x'}}, new Date('2026-10-17T06:00:00Z')).map((c) => c.id), ['a']);
    assert.equal(newsText([]), null);
    assert.equal(safe('Rush won the final\n15:00 KST · 09:00 Bucharest\nnice'), '15:00 KST · 09:00 Bucharest\nnice');
});

test('a reminder half an hour before a big match, once', async () => {
    // A minor match: not a big competition, and not two watchlist players (that is major, 26 Oct).
    const list = [m({}), m({key: 'k2', competition: {name: 'Ultimate Battle', big: false}, b: {id: 'Nobody', race: 'Z'}})];
    assert.deepEqual(dueReminders(list, {reminders: {}}, new Date('2026-10-17T05:35:00Z')).map((x) => x.key), ['k1']);
    assert.deepEqual(dueReminders(list, {reminders: {}}, new Date('2026-10-17T04:00:00Z')), [], 'too early');
    // The :15 run before a match on the hour is 45 minutes early; the :30 run is the one (17 Oct).
    assert.deepEqual(dueReminders(list, {reminders: {}}, new Date('2026-10-17T05:15:00Z')), [], '45 minutes is too early');
    assert.deepEqual(dueReminders(list, {reminders: {}}, new Date('2026-10-17T05:30:20Z')).map((x) => x.key), ['k1'], 'the :30 run, timer jitter and all');
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
    const news = {items: [{id: 'a', addedAt: '2026-10-12T05:00:00Z', headline: 'ASL S22', relevant: true, card: 'Finalists talk'}]};
    const mon8 = new Date('2026-10-12T05:00:00Z');
    await post('news', {now: mon8, posted, matches: [], news, sender});
    assert.equal(sent.length, 0, 'no news before the morning post');
    await post('morning', {now: mon8, posted, matches: [m({date: '2026-10-12'})], news, sender});
    await post('morning', {now: mon8, posted, matches: [m({date: '2026-10-12'})], news, sender});
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Finalists talk/);
    news.items.push({id: 'b', addedAt: '2026-10-12T09:00:00Z', headline: 'ASL S22', relevant: true, card: 'A new star university joins'});
    await post('news', {now: new Date('2026-10-12T09:05:00Z'), posted, matches: [], news, sender});
    assert.equal(sent.length, 2);
    assert.match(sent[1], /^🤖 Skim Bot - Brood War news/);
    news.items.push({id: 'c', addedAt: '2026-10-12T15:00:00Z', headline: 'ASL S22', relevant: true, card: 'Evening announcement'});
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
    const news = {items: [{id: 'a', addedAt: '2026-10-17T05:00:00Z', headline: 'ASL S22', relevant: true, card: 'Saturday news'}]};
    const sat8 = new Date('2026-10-17T05:00:00Z');
    await post('morning', {now: sat8, posted, matches: [m({competition: {name: 'Ultimate Battle', big: false}, b: {id: 'Nobody', race: 'Z'}})], news, sender});
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

test('a post that may have gone out is recorded and never posted again (12 Oct: three copies)', async () => {
    const posted = {mornings: {}, reminders: {}, news: {}};
    const news = {items: [{id: 'a', addedAt: '2026-10-12T05:00:00Z', headline: 'ASL S22', relevant: true, card: 'Finalists talk'}]};
    const mon8 = new Date('2026-10-12T05:00:00Z');
    let calls = 0;
    const sender = async () => { calls++; throw new UnsureError('no answer from the bridge'); };
    await assert.rejects(post('morning', {now: mon8, posted, matches: [m({date: '2026-10-12'})], news, sender}), UnsureError);
    assert.ok(posted.mornings['2026-10-12'] && posted.news.a, 'recorded as posted');
    await post('morning', {now: new Date('2026-10-12T05:15:00Z'), posted, matches: [m({date: '2026-10-12'})], news, sender});
    assert.equal(calls, 1, 'not tried again');
    // A refusal is a plain failure: nothing went out, and the next pass tries again.
    const fresh = {mornings: {}, reminders: {}, news: {}};
    await assert.rejects(post('morning', {now: mon8, posted: fresh, matches: [m({date: '2026-10-12'})], news, sender: async () => { throw new Error('the bridge did not post: PAUSED'); }}), /PAUSED/);
    assert.deepEqual(fresh.mornings, {});
});

test('send: no answer, or a post typed but not seen going, is unsure; a refusal is not', async () => {
    const at = new Date('2026-10-12T05:00:00Z');
    const answer = (status, body) => async () => ({ok: status < 300, status, json: async () => body});
    await assert.rejects(send('hi', {group: 'g', now: at, fetchImpl: async () => { throw Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}); }}), UnsureError);
    await assert.rejects(send('hi', {group: 'g', now: at, fetchImpl: answer(502, {error: 'box emptied', code: 'unconfirmed'})}), UnsureError);
    await assert.rejects(send('hi', {group: 'g', now: at, fetchImpl: answer(409, {error: 'The bridge is PAUSED'})}), (e) => !(e instanceof UnsureError) && /PAUSED/.test(e.message));
    await assert.rejects(send('hi', {group: 'g', now: at, fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'}); }}), (e) => !(e instanceof UnsureError));
    assert.deepEqual(await send('hi', {group: 'g', now: at, fetchImpl: answer(200, {sent: true, status: 'sent'})}), {sent: true, status: 'sent'});
});

test('the morning post names three stories and one sentence each; the rest count as told', async () => {
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({id: `n${n}`, addedAt: '2026-10-12T04:00:00Z', headline: 'ASL S22', relevant: true, card: `Story ${n}`, teaser: `First line ${n}. Second line ${n}.`}));
    const posted = {mornings: {}, reminders: {}, news: {}};
    const sent = [];
    await post('morning', {now: new Date('2026-10-12T05:00:00Z'), posted, matches: [m({date: '2026-10-12'})], news: {items}, sender: async (t) => { sent.push(t); return {sent: true}; }});
    assert.match(sent[0], /Story 3\*\nFirst line 3\./);
    assert.doesNotMatch(sent[0], /Story 4|Second line/);
    assert.equal(Object.keys(posted.news).length, 6);
    await post('news', {now: new Date('2026-10-12T05:15:00Z'), posted, matches: [], news: {items}, sender: async (t) => { sent.push(t); return {sent: true}; }});
    assert.equal(sent.length, 1, 'no second post with the other three');
});

test('university team results are posted once, in the morning or with the news; other results never (12 Oct)', async () => {
    const posted = {mornings: {}, reminders: {}, news: {}};
    const sent = [];
    const sender = async (text, opts) => { sent.push(await send(text, {...opts, group: 'g', fetchImpl: async (_u, r) => ({ok: true, status: 200, json: async () => ({sent: true, body: JSON.parse(r.body).text})})}).then(() => safeOf(text, opts))); return {sent: true}; };
    const safeOf = (text, opts) => safe(text, opts.allowed);
    const news = {items: [
        {id: 'u1', addedAt: '2026-10-12T04:00:00Z', date: '2026-10-11', headline: 'ASL S22', relevant: true, spoiler: true, card: 'Dreamz and Calm MonstarZ meet', teamResult: 'University Clash: Dreamz 4-2 Calm MonstarZ'},
        {id: 'p1', addedAt: '2026-10-12T04:00:00Z', headline: 'ASL S22', relevant: true, spoiler: true, card: 'Soulkey and Jaedong practise', teamResult: null},
    ]};
    await post('morning', {now: new Date('2026-10-12T05:00:00Z'), posted, matches: [], news, sender});
    assert.match(sent[0], /University results:\n\nUniversity Clash: Dreamz 4-2 Calm MonstarZ/);
    assert.match(sent[0], /Soulkey and Jaedong practise/);
    assert.doesNotMatch(sent[0], /Dreamz and Calm MonstarZ meet/, 'the result, not also its card');
    news.items.push({id: 'u2', addedAt: '2026-10-12T10:00:00Z', date: '2026-10-12', headline: 'ASL S22', relevant: true, spoiler: true, card: 'x', teamResult: 'UMS Battle: Black Academy 3-1 JSA'});
    await post('news', {now: new Date('2026-10-12T10:15:00Z'), posted, matches: [], news, sender});
    assert.equal(sent.length, 2);
    assert.match(sent[1], /^🤖 Skim Bot - University results\n\nUMS Battle: Black Academy 3-1 JSA\n/);
    await post('news', {now: new Date('2026-10-12T10:30:00Z'), posted, matches: [], news, sender});
    assert.equal(sent.length, 2, 'once');
    // A weekend: no news, but a university result still goes.
    news.items.push({id: 'u3', addedAt: '2026-10-17T06:00:00Z', date: '2026-10-17', headline: 'ASL S22', relevant: true, card: 'y', teamResult: 'CK: Double B 5-3 Dreamz'},
        {id: 'n9', addedAt: '2026-10-17T06:00:00Z', headline: 'ASL S22', relevant: true, card: 'Weekend story'});
    await post('morning', {now: new Date('2026-10-17T05:00:00Z'), posted, matches: [], news, sender});
    assert.match(sent[2], /CK: Double B 5-3 Dreamz/);
    assert.doesNotMatch(sent[2], /Weekend story/);
    // The last check lets the result line through and nothing else with a score.
    assert.equal(safe('A: Rush 4-2 Light\nCK: Double B 5-3 Dreamz', ['CK: Double B 5-3 Dreamz']), 'CK: Double B 5-3 Dreamz');
    assert.deepEqual(freshResults(news, posted, new Date('2026-10-17T05:30:00Z')), []);
});

test('a news post during the day names three stories too; the rest count as told', async () => {
    const posted = {mornings: {'2026-10-12': 'x'}, reminders: {}, news: {}};
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({id: `d${n}`, addedAt: '2026-10-12T06:00:00Z', headline: 'ASL S22', relevant: true, card: `Day story ${n}`}));
    const sent = [];
    await post('news', {now: new Date('2026-10-12T07:00:00Z'), posted, matches: [], news: {items}, sender: async (t) => { sent.push(t); return {sent: true}; }});
    assert.match(sent[0], /Day story 3/);
    assert.doesNotMatch(sent[0], /Day story 4/);
    assert.equal(Object.keys(posted.news).length, 6);
});

test('only news about a top player, the ASL, Race Wars or the Major Proleague goes to the group (12 Oct)', () => {
    const at = '2026-10-12T05:00:00Z';
    const watchlist = {players: [{id: 'Bisu'}, {id: 'Light'}, {id: 'Best'}]};
    const items = [
        {id: 'player', addedAt: at, relevant: true, card: 'Bisu plays a best-of-seven against Speed'},
        {id: 'asl', addedAt: at, relevant: true, card: 'ASL S22 groups are drawn'},
        {id: 'race', addedAt: at, relevant: true, card: 'Race Wars returns in November'},
        {id: 'mpl', addedAt: at, relevant: true, card: 'Major Proleague 5v5 line-ups are out'},
        {id: 'streamer', addedAt: at, relevant: true, card: "MBU's Kahiri is back on stream"},
        {id: 'teams', addedAt: at, relevant: true, card: "JSA vs Black Academy on Sijosae's stream"},
        {id: 'word', addedAt: at, relevant: true, card: 'The best light show of the season'},
        {id: 'model-no', addedAt: at, relevant: false, card: 'Bisu streams a charity cup'},
    ];
    const ids = freshCards({items}, {news: {}}, new Date('2026-10-12T06:00:00Z'), watchlist).map((i) => i.id);
    assert.deepEqual(ids, ['player', 'asl', 'race', 'mpl']);
});

test('a top player named only in passing in the summary does not make a story about them', () => {
    const items = [{id: 'jsa', addedAt: '2026-10-12T05:00:00Z', relevant: true, card: 'JSA vs Black Academy on a stream',
        headline: 'JSA and Black Academy face off', summary: "JSA's Skey said they had trained the Action way."}];
    assert.deepEqual(freshCards({items}, {news: {}}, new Date('2026-10-12T06:00:00Z'), {players: [{id: 'Action'}]}), []);
});

test('a match in the news carries its day, both times and where to watch, the link alone on its line (12 Oct)', () => {
    const text = newsText([{id: 'm', card: 'soma plays Bisu in a Bo3', teaser: 'Two of the best meet on soma\'s stream.',
        match: {date: '2026-10-13', time: '21:00', link: 'https://www.sooplive.com/station/thakzkf'}}]);
    assert.match(text, /\*soma plays Bisu in a Bo3\*\nTwo of the best meet on soma's stream\.\nTue 13 Oct · 21:00 KST · 15:00 Bucharest\n\nhttps:\/\/www\.sooplive\.com\/station\/thakzkf\n\nMore on the page:/);
    assert.equal(safe(text), text, 'the time line is not taken for a score');
    const dayOnly = newsBlock({card: 'A series this week', match: {date: '2026-10-14', time: null, link: null}});
    assert.equal(dayOnly, '*A series this week*\nWed 14 Oct');
});
