import test from 'node:test'
import assert from 'node:assert/strict'
import { newsProblem, NEWS_DOWN_LIMIT_MS } from '../run.mjs'

// B-355, 30 Oct: Naver's API stopped answering this machine and every hourly pass failed,
// with EloBoard and everything else done.
const T0 = new Date('2026-10-30T06:30:00Z')
const naverDown = { errors: ['naver: The operation was aborted due to timeout'], failed: ['naver'], sources: ['naver', 'eloboard'] }

test('one silent news source is a warning while another answered', () => {
    const state = {}
    assert.equal(newsProblem(naverDown, state, T0), null)
    assert.equal(state.newsDown.naver, T0.toISOString())
    assert.equal(newsProblem(naverDown, state, new Date(T0.getTime() + 3600000)), null, 'still the first failure that counts')
    assert.equal(state.newsDown.naver, T0.toISOString())
})

test('a source silent for a day fails the pass; answering again clears it', () => {
    const state = {}
    newsProblem(naverDown, state, T0)
    assert.match(newsProblem(naverDown, state, new Date(T0.getTime() + NEWS_DOWN_LIMIT_MS)), /^naver silent since 2026-10-30T06:30:00.000Z: naver: /)
    assert.equal(newsProblem({ errors: [], failed: [], sources: ['naver', 'eloboard'] }, state, new Date(T0.getTime() + NEWS_DOWN_LIMIT_MS + 1)), null)
    assert.deepEqual(state.newsDown, {})
})

test('no source answering fails the pass at once', () => {
    const all = { errors: ['naver: timeout', 'eloboard: 503'], failed: ['naver', 'eloboard'], sources: ['naver', 'eloboard'] }
    assert.equal(newsProblem(all, {}, T0), 'naver: timeout; eloboard: 503')
})
