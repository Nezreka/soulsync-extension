// Stand-in for webextension-polyfill: src/shared/api.ts imports it, but the
// pure functions under test never touch `browser`.
const browser = new Proxy({}, { get: () => { throw new Error("browser stub touched"); } });
export default browser;
