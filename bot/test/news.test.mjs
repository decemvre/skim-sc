import test from 'node:test';
import assert from 'node:assert/strict';

import {aboutBroodWar, check} from '../news.mjs';
import {cleanItem, digest, firstJson, prompt} from '../digest.mjs';
import {newsSection, injectNews, END, NEWS_START, NEWS_END} from '../page.mjs';

// F-234: Korean Brood War news in English, never a real name, never a spoiler outside a fold.
const names = {players: {'유영진': {id: 'Rush', race: 'T', romanized: 'Yoo Young Jin'}, '김민철': {id: 'Soulkey', race: 'Z', romanized: 'Kim Min Chul'}}, unknown: {}};

test('what counts as Brood War news', () => {
    assert.equal(aboutBroodWar('[ASL] 결승 오른 유영진 "아이스링크장, 너무 기대된다"'), true);
    assert.equal(aboutBroodWar('스타크래프트2 GSL 시즌2 개막'), false);
    assert.equal(aboutBroodWar("'리니지 리마스터', 황금사막 아벨라 업데이트"), false);
    assert.equal(aboutBroodWar('김민철, 스타 결승 진출', names.players), true);
});

test('the watcher queues each story once, whatever the source does', async () => {
    const item = {id: 'naver:1:2', source: 'X', lang: 'ko', title: '[ASL] t', summary: '', link: 'l', at: null};
    const sources = {naver: async () => [item]};
    const first = await check({now: new Date('2026-10-10T09:00:00Z'), queue: {seen: {}, items: []}, names: {}, sources});
    assert.equal(first.fresh.length, 1);
    const again = await check({now: new Date('2026-10-10T10:00:00Z'), queue: first.queue, names: {}, sources});
    assert.equal(again.fresh.length, 0);
});

test('{{name:...}} becomes the ID, or "a player"; anything still naming a person is dropped', async () => {
    const lookupless = {lookup: false};
    const ok = await cleanItem({headline: '{{name:유영진}} into the final', summary: '{{name:김민철}} waits.', spoiler: true, card: 'Both finalists talk before Saturday', sources: ['l'], date: '2026-10-07'}, names, lookupless);
    assert.equal(ok.headline, 'Rush into the final');
    assert.equal(ok.summary, 'Soulkey waits.');
    const unknown = await cleanItem({headline: '{{name:홍길동}} retires', summary: 's', spoiler: false, card: null, sources: [], date: 'd'}, names, lookupless);
    assert.equal(unknown.headline, 'a player retires');
    assert.equal(await cleanItem({headline: '유영진 wins', summary: '', spoiler: true, card: null, sources: [], date: 'd'}, names, lookupless), null, 'Hangul left in');
    assert.equal(await cleanItem({headline: 'Yoo Young Jin wins', summary: '', spoiler: true, card: null, sources: [], date: 'd'}, names, lookupless), null, 'a romanized real name');
});

test('no queue, no model run; a failing Claude falls back to Grok; the queue is marked done', async () => {
    const empty = await digest({queue: {seen: {}, items: []}, names, news: {items: []}, runners: {}});
    assert.equal(empty.ran, false);
    const queue = {seen: {}, items: [{title: 't', summary: 's', link: 'l', source: 'TL.net', lang: 'en', done: false, queuedAt: '2026-10-10T00:00:00Z'}]};
    const runners = {claude: async () => { throw new Error('limit'); }, grok: async (p) => { assert.match(p, /\{\{name:/); return {items: [{headline: 'h', summary: 's', spoiler: false, card: 'c', sources: ['l'], date: '2026-10-10'}]}; }};
    const r = await digest({queue, names, news: {items: []}, runners, lookup: false, now: new Date('2026-10-10T12:00:00Z')});
    assert.equal(r.by, 'grok');
    assert.equal(r.added.length, 1);
    assert.equal(queue.items[0].done, true);
});

test('the prompt asks for placeholders instead of names, and a spoiler-free card', () => {
    const p = prompt([{source: 'Naver', lang: 'ko', title: '[ASL] 유영진 결승', summary: '', link: 'l', at: null}]);
    assert.match(p, /NEVER write a person's real name/);
    assert.match(p, /reveals NO result/);
    assert.deepEqual(firstJson('Sure: {"items": [{"a": "}"}]} trailing'), {items: [{a: '}'}]});
});

test('on the page a spoiler shows only its card; the story is folded', () => {
    const html = newsSection({items: [
        {date: '2026-10-07', headline: 'Rush beats Light 4-2', summary: 'Into the final.', spoiler: true, card: 'Semifinal night in Seoul', sources: ['l']},
        {date: '2026-10-08', headline: 'Rollback netcode thread', summary: 'Talk.', spoiler: false, card: 'c', sources: ['l2']},
    ]});
    const [visible] = html.split('<details');
    assert.match(visible, /Semifinal night in Seoul/);
    assert.doesNotMatch(visible, /4-2/);
    assert.match(html, /Rollback netcode thread/);
    assert.equal(injectNews(`a${END}b`, `${NEWS_START}N${NEWS_END}`), `a${END}\n${NEWS_START}N${NEWS_END}b`);
});
