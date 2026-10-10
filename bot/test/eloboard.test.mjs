import test from 'node:test';
import assert from 'node:assert/strict';

import {isMatch, parseDay, parseMonth, parseNews} from '../sources/eloboard.mjs';
import {translateTitle, HANGUL} from '../lib/terms.mjs';
import {refresh} from '../matches.mjs';

// F-238: EloBoard's schedule and news. Matches kept, broadcasts dropped, SOOP wins overlaps,
// nothing in Korean shown until it is translated.

test('matches, not broadcasts', () => {
    for (const t of ['[대학대전] 드림즈 vs 캄몬', 'CK 더블비 VS 드림즈 교수ck', '[마범대] 마범컵 5,6 티어 대회', '[마범대] 유스 종족최강자전 개최']) assert.equal(isMatch(t), true, t);
    for (const t of ['츠학슬늑 캠핑방송', '[풋살대결] 신세계 VS 캄몬 풋살대결', '[뉴캣슬] 최도랑배 대대적 서든 2부', '정중만 나락단 공개 오디션', '[JSA] 테란반 글램핑 려원방송!']) assert.equal(isMatch(t), false, t);
});

test('titles in English; what is left in Korean is said so', () => {
    assert.equal(translateTitle('[대학대전] 드림즈 vs 캄몬'), '[University Clash] Dreamz vs Calm MonstarZ');
    assert.equal(translateTitle('[중계진]Google Play 스페셜 끝장전 이재호 vs 박상현'), 'Special Ultimate Battle 이재호 vs 박상현');
    assert.equal(translateTitle('[마범대] 마범컵 5,6 티어 대회'), '[MBU] Ma Beom Cup Tier 5–6 Tournament');
    assert.equal(HANGUL.test(translateTitle('마범대 VS 드림즈 2만개빵 미니대학대전 즉흥')), true);
});

test('the month grid and a full day; the page\'s ads are not part of a title', () => {
    const month = `<a class="x" href="/schedule?m=2026-10&amp;d=2026-10-15&amp;k=match"><b>15</b><span class="m__entries"><span class="m__entry "><i class="d"></i><em>19:00</em><span>[대학대전] 드림즈 vs 캄몬</span></span></span></a>
      <a href="/schedule?m=2026-10&amp;d=2026-10-24&amp;k=match"><span class="m__entry "><i></i><span>[마범대] 마범컵 5,6 티어 대회</span></span></a>`;
    assert.deepEqual(parseMonth(month).entries, [{date: '2026-10-15', time: '19:00', title: '[대학대전] 드림즈 vs 캄몬'}, {date: '2026-10-24', time: null, title: '[마범대] 마범컵 5,6 티어 대회'}]);
    const day = '<div>10월 10일 (토)</div><b>7</b><span>건</span><em>17:00</em><span>미니대전</span><span>마범대 vs 더블비</span><em>19:00</em><span>[실력점검] 케이대 유스</span><span>LIVE</span><span>· 4,796명</span><span>자세히 알아보기</span><span>인문학 도서 탐색</span><a>개인정보처리방침</a>';
    assert.deepEqual(parseDay(day, '2026-10-10'), [{date: '2026-10-10', time: '17:00', title: '미니대전 마범대 vs 더블비', tagged: true}, {date: '2026-10-10', time: '19:00', title: '[실력점검] 케이대 유스'}]);
});

test('news articles, one queue item each', () => {
    const items = parseNews('<article class="a"><h2>신세계, 유스 천유주 영입</h2><p>신세계가 오피셜로 유스 천유주를 맞았습니다. 같은 오피셜에서 뽀깽이도 함께.</p><a href="/community/posts/413">원글</a></article>', '2026-10-09');
    assert.equal(items.length, 1);
    assert.equal(items[0].link, 'https://eloboard.com/community/posts/413');
    assert.match(items[0].id, /^eloboard:2026-10-09:[0-9a-f]{10}$/);
});

test('in the schedule: SOOP wins a duel both list; names become IDs; untranslated waits', async () => {
    const names = {players: {'유영진': {id: 'Rush', race: 'T'}, '김민철': {id: 'Soulkey', race: 'Z'}, '이재호': {id: 'Light', race: 'T'}, '박상현': {id: 'soma', race: 'Z'}}, unknown: {}};
    const soop = async () => [{date: '2026-10-17', kst: '15:00', competition: 'Google Play ASL Season 22', a: {korean: '유영진', race: 'T'}, b: {korean: '김민철', race: 'Z'}, played: false, status: 'Upcoming'}];
    const eloboard = async () => [
        {date: '2026-10-17', time: '17:00', title: '유영진 vs 김민철'},
        {date: '2026-10-13', time: '21:00', title: '[중계진]Google Play 스페셜 끝장전 이재호 vs 박상현'},
        {date: '2026-10-10', time: '19:00', title: '마범대 VS 드림즈 2만개빵 미니대학대전 즉흥'},
    ];
    const r = await refresh({today: '2026-10-10', read: soop, eloboard, names, lookup: false, saved: {matches: []}, now: new Date('2026-10-10T00:00:00Z')});
    const fromEloboard = r.file.matches.filter((m) => m.origin === 'eloboard');
    assert.equal(fromEloboard.length, 2, 'the final is SOOP\'s');
    assert.equal(fromEloboard.find((m) => m.date === '2026-10-13').titleEn, 'Special Ultimate Battle Light vs soma');
    const waiting = fromEloboard.find((m) => m.date === '2026-10-10');
    assert.equal(waiting.needsTranslation, true);
    assert.equal(waiting.titleEn, null);
});
