/* Connection failure guidance (real src/shared/api.ts). fetch() reports
 * every transport failure as an opaque TypeError; against an http:// LAN
 * address the actionable cause is usually Firefox upgrading the request to
 * https (HTTPS-Only Mode), which a plain-http SoulSync server cannot
 * answer. connectionHint names that case and passes everything else —
 * including errors where the server actually answered — through untouched. */
import { connectionHint } from "../src/shared/api.ts";

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}
function ok(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) fails++;
}

const httpCfg = { url: "http://192.168.4.35:8008", apiKey: "sk_x" };
const httpsCfg = { url: "https://soulsync.lan:8008", apiKey: "sk_x" };
const networkError = new TypeError("NetworkError when attempting to fetch resource.");

/* http + transport failure: the guidance fires and names the fix */
{
  const hint = connectionHint(httpCfg, networkError);
  ok("http + TypeError yields guidance", hint !== networkError && /HTTPS-Only Mode/.test(hint.message));
  ok("guidance names the address", hint.message.includes("http://192.168.4.35:8008"));
  ok("guidance keeps the https-url alternative", /serve SoulSync over\s+https/.test(hint.message));
  ok("guidance keeps the original error text",
    hint.message.includes("NetworkError when attempting to fetch resource."));
  ok("guidance also names the old-server cause", /predate the CORS support/.test(hint.message));
}

/* trailing slash and uppercase scheme still count as plain http */
{
  const slash = connectionHint({ url: "http://192.168.4.35:8008/", apiKey: "sk_x" }, networkError);
  ok("trailing-slash http yields guidance", /HTTPS-Only Mode/.test(slash.message));
  const upper = connectionHint({ url: "HTTP://192.168.4.35:8008", apiKey: "sk_x" }, networkError);
  ok("uppercase HTTP yields guidance", /HTTPS-Only Mode/.test(upper.message));
}

/* an abort is not a TypeError: it passes through untouched */
{
  const abort = new DOMException("The user aborted a request.", "AbortError");
  eq("AbortError passes through", connectionHint(httpCfg, abort).message, abort.message);
}

/* a TypeError that is not a network failure (e.g. an invalid header value
 * from a pasted API key) keeps its own message — it is not "nothing
 * answered" and must not be sent chasing Firefox settings */
{
  const local = new TypeError("Failed to execute 'fetch' on 'Window': Invalid value");
  eq("non-network TypeError passes through", connectionHint(httpCfg, local).message, local.message);
  const safari = new TypeError("Load failed");
  ok("Safari network TypeError yields guidance", /HTTPS-Only Mode/.test(connectionHint(httpCfg, safari).message));
  const chrome = new TypeError("Failed to fetch");
  ok("Chrome network TypeError yields guidance", /HTTPS-Only Mode/.test(connectionHint(httpCfg, chrome).message));
}

/* https + transport failure: nothing to upgrade, original error stands */
{
  const hint = connectionHint(httpsCfg, networkError);
  eq("https + TypeError passes through", hint.message, networkError.message);
}

/* http + an answer from the server: not a transport problem, untouched */
{
  const answered = new Error("Server returned 401");
  eq("http + server error passes through", connectionHint(httpCfg, answered).message, "Server returned 401");
}

/* the extension's own timeout message is an Error, not a TypeError */
{
  const timeout = new Error("Your SoulSync server didn't answer within 20s.");
  eq("timeout message passes through", connectionHint(httpCfg, timeout).message, timeout.message);
}

/* non-Error throwables are wrapped, never rethrown raw */
{
  const hint = connectionHint(httpCfg, "boom");
  ok("string throwable wrapped", hint instanceof Error && hint.message === "boom");
  const undef = connectionHint(httpCfg, undefined);
  ok("undefined throwable wrapped", undef instanceof Error && undef.message === "undefined");
}

if (fails) {
  console.error(`${fails} connection-logic test(s) FAILED`);
  process.exit(1);
}
console.log("connection-logic: all passed");
