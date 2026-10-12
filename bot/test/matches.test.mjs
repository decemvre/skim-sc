import test from 'node:test';
import assert from 'node:assert/strict';

import {parseSchedule, textLines} from '../sources/soop.mjs';
import {englishNicknames, matches} from '../lib/names.mjs';
import {infobox} from '../lib/liquipedia.mjs';
import {competition} from '../lib/competitions.mjs';
import {bucharest, kstInstant} from '../lib/time.mjs';
import {monthsToRead, refresh} from '../matches.mjs';

// F-231. The schedule as SOOP shows it on 2026-10-10, trimmed.
const PAGE = `<div>Schedule List</div><div>10-05(Mon)</div><div>Google Play ASL Season 22</div><span>19:00</span><span>유영진(T)</span><span>SCORE</span>
<span>이재호(T)</span><span>Replay</span><div>10-10(Sat)</div><div>Today</div><p>There are no matches on this date.</p>
<div>10-14(Wed)</div><div>HyperX배 연예인 스타리그 시즌2</div><span>20:00</span><span>비트 리벤저스</span><span>vs</span><span>메디카 스타즈</span><span>Upcoming</span>
<div>10-17(Sat)</div><div>Google Play ASL Season 22</div><span>15:00</span><span>유영진(T)</span><span>vs</span><span>김민철(Z)</span><span>Upcoming</span>`;

test('the schedule page reads as matches; a played one is marked, its result never read', () => {
    const list = parseSchedule(textLines(PAGE), '2026');
    assert.equal(list.length, 3);
    assert.deepEqual(list[0], {date: '2026-10-05', kst: '19:00', competition: 'Google Play ASL Season 22',
        a: {korean: '유영진', race: 'T'}, b: {korean: '이재호', race: 'T'}, played: true, status: 'Replay'});
    assert.deepEqual(list[1].a, {korean: '비트 리벤저스', race: null, team: true});
    assert.equal(list[2].played, false);
});

test('a Liquipedia infobox is accepted only for the same Korean name and race', () => {
    const box = infobox('{{Infobox player\n|id=Rush\n|name=유영진(柳英眞)\n|romanized_name=Yoo Young Jin\n|race=Terran\n|nicknames=Future Terran, ASLCHAMPRush\n|afreeca=rushplays\n}}');
    assert.deepEqual(box, {id: 'Rush', name: '유영진(柳英眞)', romanized: 'Yoo Young Jin', race: 'Terran', nicknames: ['Future Terran', 'ASLCHAMPRush'], afreeca: 'rushplays'});
    assert.equal(matches(box, '유영진', 'T'), true);
    assert.equal(matches(box, '유영진', 'Z'), false, 'same name, other race: a different player');
    assert.equal(matches(box, '김민철', 'T'), false);
});

test('names: known ones from the table, unknown ones looked up once a day and never guessed', async () => {
    const table = {players: {'김민철': {id: 'Soulkey', race: 'Z'}}, unknown: {}};
    let asked = 0;
    const read = async () => [{date: '2026-10-17', kst: '15:00', competition: 'Google Play ASL Season 22', a: {korean: '김민철', race: 'Z'}, b: {korean: '홍길동', race: 'P'}, played: false, status: 'Upcoming'}];
    const r = await refresh({today: '2026-10-10', read, names: table, lookup: false, saved: {matches: []}, now: new Date('2026-10-10T00:00:00Z')});
    assert.equal(r.file.matches[0].a.id, 'Soulkey');
    assert.equal(r.file.matches[0].b.id, null, 'not matched: left unknown');
    assert.deepEqual(r.unknownNames, ['홍길동']);
    assert.equal(asked, 0);
});

test('a future match that leaves the schedule is kept and marked, not dropped', async () => {
    const saved = {matches: [{key: '2026-10-12 21:00 김민철 vs 김지성', date: '2026-10-12', onSchedule: true, at: '2026-10-12T12:00:00.000Z'}]};
    const other = {date: '2026-10-17', kst: '15:00', competition: 'Google Play ASL Season 22', a: {korean: '김민철', race: 'Z'}, b: {korean: '홍길동', race: 'P'}, played: false, status: 'Upcoming'};
    const r = await refresh({today: '2026-10-10', read: async () => [other], names: {players: {}, unknown: {}}, lookup: false, saved});
    assert.deepEqual(r.changes.filter((c) => c.kind === 'gone'), [{kind: 'gone', key: '2026-10-12 21:00 김민철 vs 김지성'}]);
    assert.equal(r.file.matches.find((m) => m.key.startsWith('2026-10-12')).onSchedule, false);
});

test('times: KST to Bucharest, EEST until 25 October 2026 and EET after', () => {
    assert.deepEqual(bucharest(kstInstant('2026-10-17', '15:00')), {date: '2026-10-17', time: '09:00', zone: 'EEST'});
    assert.deepEqual(bucharest(kstInstant('2026-10-28', '20:00')), {date: '2026-10-28', time: '13:00', zone: 'EET'});
    assert.deepEqual(bucharest(kstInstant('2026-10-18', '02:00')), {date: '2026-10-17', time: '20:00', zone: 'EEST'});
});

test('competitions get our names; the next month is read near the end of this one', () => {
    assert.equal(competition('Google Play ASL Season 22').name, 'ASL Season 22');
    assert.equal(competition('Google Play ASL Season 22').big, true);
    assert.equal(competition('HyperX배 연예인 스타리그 시즌2').name, 'Celebrity StarLeague Season 2');
    assert.equal(competition('신규 대회').known, false);
    assert.deepEqual(monthsToRead('2026-10-10'), ['2026-10-01']);
    assert.deepEqual(monthsToRead('2026-10-25'), ['2026-10-01', '2026-11-01']);
    assert.deepEqual(monthsToRead('2026-12-28'), ['2026-12-01', '2027-01-01']);
});

test('nicknames: only what we can read', () => {
    assert.deepEqual(englishNicknames(['철벽Iron Wall(铁壁)', '永康', 'Doh-men', '괴룡(怪龍)', 'ASLCHAMPRush']), ['Iron Wall', 'Doh-men', 'ASLCHAMPRush']);
});

test('an empty SOOP month we had matches for is a failed read, not a month of cancellations', async () => {
    const saved = {matches: [{key: 'k', origin: 'soop', date: '2026-10-17', onSchedule: true}]};
    await assert.rejects(refresh({today: '2026-10-10', read: async () => [], names: {players: {}, unknown: {}}, lookup: false, saved}), /came back empty/);
});
