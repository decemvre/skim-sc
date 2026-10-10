import test from 'node:test';
import assert from 'node:assert/strict';

import {plan, summaryFor, shortName} from '../calendar.mjs';

// F-232: the calendar plan. Hand-made events are adopted, not duplicated; nothing is deleted.
const match = (over = {}) => ({key: '2026-10-17 15:00 유영진 vs 김민철', date: '2026-10-17', kst: '15:00', at: '2026-10-17T06:00:00.000Z',
    bucharest: {time: '09:00', zone: 'EEST'}, competition: {name: 'ASL Season 22', celebrity: false, watch: null},
    a: {id: 'Rush', race: 'T'}, b: {id: 'Soulkey', race: 'Z'}, onSchedule: true, source: 'https://esports.sooplive.com/schedule/sc1?date=2026-10-17', ...over});

test('a hand-made event at the same time for the same competition is adopted, keeping its stage', () => {
    const events = [{id: 'h1', summary: 'ASL S22 Final — TBD vs TBD', start: {dateTime: '2026-10-17T09:00:00+03:00'}},
        {id: 'h2', summary: 'Ma Beom Cup — Tier 5–6', start: {dateTime: '2026-10-17T09:00:00+03:00'}}];
    const steps = plan([match()], events, {today: '2026-10-10'});
    assert.equal(steps.length, 1);
    assert.equal(steps[0].do, 'adopt');
    assert.equal(steps[0].id, 'h1');
    assert.equal(steps[0].body.summary, 'ASL S22 Final — Rush vs Soulkey');
    assert.equal(steps[0].body.extendedProperties.private.skimKey, match().key);
});

test('our own event is updated only when something changed; past and celebrity matches are left alone', () => {
    const first = plan([match()], [], {today: '2026-10-10'})[0];
    assert.equal(first.do, 'create');
    const ours = {id: 'm1', ...first.body};
    assert.deepEqual(plan([match()], [ours], {today: '2026-10-10'}), []);
    const moved = plan([match({onSchedule: false})], [ours], {today: '2026-10-10'});
    assert.equal(moved[0].do, 'update');
    assert.match(moved[0].body.summary, /^\[\?\] ASL S22 — Rush vs Soulkey/);
    assert.deepEqual(plan([match({date: '2026-10-05'})], [], {today: '2026-10-10'}), []);
    assert.deepEqual(plan([match({competition: {name: 'Celebrity StarLeague Season 2', celebrity: true}})], [], {today: '2026-10-10'}), []);
});

test('names on the calendar: IDs, a ? for one we could not match, never a real name', () => {
    assert.equal(shortName('ASL Season 22'), 'ASL S22');
    assert.equal(summaryFor(match({b: {korean: '홍길동', id: null, race: 'P'}})), 'ASL S22 — Rush vs ? (P)');
});
