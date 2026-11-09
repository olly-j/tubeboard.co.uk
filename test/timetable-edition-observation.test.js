import test from 'node:test';
import assert from 'node:assert/strict';
import { OBSERVATION_PATH, TimetableEditionObservation, handleEditionObservation } from '../server/timetable-edition-observation.js';
import { TIMETABLE_PUBLICATION_URL } from '../server/station-board-seed.js';

const start = Date.UTC(2026, 10, 9, 18, 30);
const signal = new AbortController().signal;
const sha = 'ab'.repeat(32);
function origin({ headers = {}, status = 200 } = {}) {
  return { status, headers: new Headers({ date: new Date(start).toUTCString(), 'x-amz-meta-sha256': sha, ...headers }) };
}
test('one scheduled HEAD retries missing Age on the same fixed URL and expires on publisher time', async () => {
  let now = start + 2000;
  const calls = [];
  const observation = new TimetableEditionObservation({ now: () => now, fetchImpl: (url, options) => {
    calls.push(url.href);
    assert.equal(url.origin + url.pathname, TIMETABLE_PUBLICATION_URL);
    assert.deepEqual([...url.searchParams.keys()], ['tb085']);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'HEAD');
    return origin({ headers: calls.length === 1 ? {} : { age: '4' } });
  } });
  assert.equal(observation.current(), null);
  await observation.refresh(signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  for (let i = 0; i < 5; i++) assert.deepEqual(observation.current(), { schemaVersion: 1, source: TIMETABLE_PUBLICATION_URL,
    publicationSHA256: sha, observedAt: new Date(start - 2000).toISOString(), expiresAt: new Date(start + 598000).toISOString() });
  now = start + 598000;
  assert.equal(observation.current(), null);
  assert.equal(calls.length, 2);
});

test('invalid, contradictory, stale and failed observations invalidate existing positives', async () => {
  for (const result of [origin({ status: 403 }), origin(), origin({headers:{age:'600'}}),
    origin({headers:{age:'0',date:new Date(start+1000).toUTCString()}}),
    origin({headers:{age:'0','x-amz-meta-sha256':'malformed'}}),
    origin({headers:{age:'0','x-amz-meta-sha256':'cd'.repeat(32)}}),
    origin({headers:{age:'1'}}), null]) {
    let answer = origin({headers:{age:'0'}});
    const observation = new TimetableEditionObservation({ now: () => start, fetchImpl: () => {
      if (!answer) throw Error('offline');
      return answer;
    } });
    await observation.refresh(signal);
    answer = result;
    await assert.rejects(observation.refresh(signal));
    assert.equal(observation.current(), null);
  }
});

test('route reads memory only, rejects query and methods, supports HEAD', () => {
  let calls = 0;
  const state = {current() { calls++; return calls === 1 ? null : {schemaVersion:1}; }};
  const response = { setHeader(k,v) { assert.deepEqual([k,v],['allow','GET, HEAD']); } };
  for (const [method, target, code] of [['GET',OBSERVATION_PATH,503],['HEAD',OBSERVATION_PATH,200],
    ['GET',OBSERVATION_PATH,200],['POST',OBSERVATION_PATH,405],['GET',OBSERVATION_PATH+'?url=test',400]]) {
    assert.ok(handleEditionObservation({method,url:target},response,new URL(target,'http://localhost'),state,
      (_response,status,_payload,cache,head=false) => {
        assert.deepEqual([status,cache,head],[code,'no-store',method==='HEAD']);
      }));
  }
  assert.equal(calls,3);
});
