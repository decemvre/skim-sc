import test from 'node:test';
import assert from 'node:assert/strict';

import {inject, section, START, END} from '../page.mjs';
import {matchBlocks, parseMatch, addResults} from '../results.mjs';

// F-233: the bot's part of the page. Players by ID only, results only behind a closed dropdown.
const m = (over) => ({date: '2026-10-17', kst: '15:00', at: '2026-10-17T06:00:00.000Z', bucharest: {time: '09:00', zone: 'EEST'},
    competition: {name: 'ASL Season 22', liquipedia: 'ASL/22'}, a: {korean: '유영진', id: 'Rush', race: 'T'}, b: {korean: '김민철', id: 'Soulkey', race: 'Z'},
    played: false, onSchedule: true, ...over});
const file = {matches: [m({date: '2026-10-05', played: true, b: {korean: '이재호', id: 'Light', race: 'T'}, result: {a: 4, b: 2}}), m({})]};

test('upcoming in the open, results only inside a closed <details>, never a real name', () => {
    const html = section(file, {today: '2026-10-10', now: new Date('2026-10-10T09:00:00Z')});
    assert.ok(html.startsWith(START) && html.endsWith(END));
    const [open, spoilers] = html.split('<details class="spoilers">');
    assert.match(open, /Rush.*vs.*Soulkey/s);
    assert.doesNotMatch(open, /4–2/, 'no score outside the dropdown');
    assert.match(spoilers, /4–2/);
    assert.doesNotMatch(html, /<details[^>]*\bopen\b/, 'the dropdown starts closed');
    assert.doesNotMatch(html, /<script/);
    for (const korean of ['유영진', '김민철', '이재호']) assert.ok(!html.includes(korean), `${korean} must not appear`);
});

test('inject: the first time before "On the circuit", afterwards in place', () => {
    const page = '<main><section id="calendar"></section><section id="tournaments">x</section></main>';
    const once = inject(page, `${START}A${END}`);
    assert.equal(once, `<main><section id="calendar"></section>${START}A${END}\n<section id="tournaments">x</section></main>`);
    assert.equal(inject(once, `${START}B${END}`), once.replace(`${START}A${END}`, `${START}B${END}`));
});

test('results from Liquipedia: maps won, matched by day and both IDs, either way round', async () => {
    const page = `|M1={{Match|bestof=7\n|date=2026-10-05 19:00 {{Abbr/KST}}\n|opponent1={{1Opponent|Light}}\n|opponent2={{1Opponent|Rush}}\n|map1={{Map|winner=2|map=A}}\n|map2={{Map|winner=1|map=B}}\n|map3={{Map|winner=2|map=C}}\n}}`;
    assert.deepEqual(parseMatch(matchBlocks(page)[0]), {date: '2026-10-05', players: ['Light', 'Rush'], score: [1, 2]});
    const list = [m({date: '2026-10-05', played: true, b: {id: 'Light', race: 'T'}})];
    assert.equal(await addResults(list, {read: async () => page}), 1);
    assert.deepEqual([list[0].result.a, list[0].result.b], [2, 1]);
});
