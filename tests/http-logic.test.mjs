/* Transport tests: v1 pacing, 429 retry, timeouts (real src/shared/http.ts,
 * fetch stubbed per case). Limits are shrunk so the suite runs in seconds. */
import { isV1Path, resetServerFetchState, serverFetch } from "../src/shared/http.ts";

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}
const res = (status) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

eq("v1 path", isV1Path("http://s:8008/api/v1/search/tracks"), true);
eq("non-v1 path", isV1Path("http://s:8008/api/watchlist/check"), false);
eq("v1 lookalike is not v1", isV1Path("http://s/api/v10/x"), false);

/* 429 is retried after the backoff, then succeeds */
{
  resetServerFetchState({ backoffMs: [20, 20, 20] });
  let calls = 0;
  globalThis.fetch = async () => (++calls < 3 ? res(429) : res(200));
  const r = await serverFetch("http://s/api/v1/library/artists");
  eq("429 retried until ok", [r.status, calls], [200, 3]);
}

/* 429 forever: the last 429 comes back to the caller (no infinite loop) */
{
  resetServerFetchState({ backoffMs: [5, 5] });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(429); };
  const r = await serverFetch("http://s/api/v1/library/artists");
  eq("persistent 429 surfaces after retries", [r.status, calls], [429, 3]);
}

/* the pacer holds a burst to the budget per window */
{
  resetServerFetchState({ budget: 3, windowMs: 150 });
  const stamps = [];
  globalThis.fetch = async () => { stamps.push(Date.now()); return res(200); };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => serverFetch("http://s/api/v1/system/stats")));
  const late = stamps.filter((t) => t - t0 >= 140).length;
  eq("burst beyond budget waits for the window", late, 2);
}

/* non-v1 routes skip the pacer */
{
  resetServerFetchState({ budget: 1, windowMs: 10_000 });
  globalThis.fetch = async () => res(200);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => serverFetch("http://s/api/library/check-tracks")));
  eq("non-v1 not paced", Date.now() - t0 < 1000, true);
}

/* a server that never answers times out with a plain message */
{
  resetServerFetchState();
  globalThis.fetch = (_u, init) => new Promise((_r, rej) => {
    init.signal.addEventListener("abort", () => rej(new Error("aborted")));
  });
  let msg = "";
  try { await serverFetch("http://s/api/v1/system/stats", {}, { timeoutMs: 30 }); } catch (e) { msg = e.message; }
  eq("timeout -> readable error", /didn't answer/.test(msg), true);
}

if (fails) { console.error(`${fails} FAILURES`); process.exit(1); }
console.log("ALL HTTP TRANSPORT TESTS PASSED");
