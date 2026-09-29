import browser from 'webextension-polyfill';

const MENU_ID = 'soulsync-send-selection';
const PENDING_KEY = 'pendingSelection';

browser.runtime.onInstalled.addListener(async () => {
  await browser.contextMenus.removeAll().catch(() => undefined);
  browser.contextMenus.create({
    id: MENU_ID,
    title: 'Send to SoulSync',
    contexts: ['selection'],
  });
});

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || typeof info.selectionText !== 'string') return;
  // Stash the raw selection; the popup's text-import view picks it up.
  await browser.storage.session.set({ [PENDING_KEY]: info.selectionText });
  // Best effort: pop the popup so the user can review the parse immediately.
  // openPopup() needs a user gesture and can fail (e.g. no focusable window);
  // the pending text survives until the next popup open regardless.
  try {
    await browser.action.openPopup();
  } catch {
    /* picked up on next open */
  }
});
