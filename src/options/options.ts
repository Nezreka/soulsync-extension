import browser from 'webextension-polyfill';
import { getConfig, saveConfig, testConnection } from '../shared/api.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function note(msg: string, isError = false): void {
  const el = $('note');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function readForm(): { url: string; apiKey: string } {
  return {
    url: ($('server-url') as HTMLInputElement).value.trim(),
    apiKey: ($('api-key') as HTMLInputElement).value.trim(),
  };
}

document.addEventListener('DOMContentLoaded', () => {
  void (async () => {
    const cfg = await getConfig();
    if (cfg) {
      ($('server-url') as HTMLInputElement).value = cfg.url;
      ($('api-key') as HTMLInputElement).value = cfg.apiKey;
    }
  })();

  $('test').addEventListener('click', () => {
    void (async () => {
      const { url, apiKey } = readForm();
      if (!url || !apiKey) {
        note('Enter both the server URL and API key first.', true);
        return;
      }
      $('test').setAttribute('disabled', '');
      try {
        const msg = await testConnection({ url, apiKey });
        await saveConfig({ url, apiKey });
        note(`${msg} Settings saved.`);
      } catch (e) {
        note(e instanceof Error ? e.message : String(e), true);
      } finally {
        $('test').removeAttribute('disabled');
      }
    })();
  });

  $('save').addEventListener('click', () => {
    void (async () => {
      const { url, apiKey } = readForm();
      if (!url || !apiKey) {
        note('Enter both the server URL and API key first.', true);
        return;
      }
      await saveConfig({ url, apiKey });
      note('Saved. Use Test connection to verify and grant host permission.');
    })();
  });
});
