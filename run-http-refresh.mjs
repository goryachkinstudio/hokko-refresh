import {pathToFileURL} from 'node:url';

export async function runLane({base, key, lane, runId = 'manual', deadline = Date.now() + 45 * 60_000, request = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log}) {
  if (new URL(base).origin !== 'https://hokko.goryachkinstudio.chatgpt.site') throw Error('Unexpected Site origin');
  if (!key || key.length < 32) throw Error('Refresh service key is missing');
  let errors = 0;
  while (Date.now() < deadline) {
    let response, value;
    try {
      response = await request(base + '/api/maintenance/refresh', {
        method: 'POST', headers: {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
        body: JSON.stringify({lane, runId}), signal: AbortSignal.timeout(150_000), redirect: 'error',
      });
      value = await response.json();
      if ([401, 403, 404].includes(response.status)) throw Object.assign(Error(`Updater access failed: HTTP ${response.status}`), {terminal: true});
      if (!response.ok) throw Error(value.error || `Updater returned HTTP ${response.status}`);
      errors = 0;
    } catch (error) {
      if (error.terminal || ++errors >= 5) throw error;
      log(JSON.stringify({lane, status: 'retry', attempt: errors, error: String(error.message).replaceAll(key, '[redacted]')}));
      await wait(Math.min(60_000, 5000 * 2 ** (errors - 1)));
      continue;
    }
    log(JSON.stringify(value));
    if (['complete', 'unchanged'].includes(value.status)) {
      if (value.sourceErrors?.length) throw Error(`${lane}: ${value.sourceErrors.length} sources retained with errors`);
      return value;
    }
    if (!['busy', 'progress'].includes(value.status)) throw Error('Updater returned an unconfirmed state');
    const delay = value.status === 'busy' ? Math.max(1000, Math.min(120_000, Number(value.retryAt) - Date.now() || 15_000)) : 250;
    await wait(delay);
  }
  throw Error(`${lane}: run deadline reached; stored collection can resume on the next run`);
}

async function input() {
  if (!process.argv.includes('--stdin')) return {key: process.env.HOKKO_REFRESH_SERVICE_KEY, lanes: (process.env.HOKKO_LANES || 'mhl,youth,careers,archive').split(','), runId: process.env.GITHUB_RUN_ID ? 'github-actions:' + process.env.GITHUB_RUN_ID : 'manual'};
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stderr.write('Ready for refresh JSON on stdin (input is hidden).\n');
  let text = '';
  return new Promise((resolve, reject) => {
    process.stdin.on('data', chunk => {
      text += chunk.toString();
      if (text.length > 3000) reject(Error('Input too long'));
      if (text.includes('\n')) {
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = await input();
  const lanes = options.lanes || ['mhl', 'youth', 'careers', 'archive'];
  if (lanes.some(lane => !['mhl', 'youth', 'careers', 'archive'].includes(lane))) throw Error('Unknown collection lane');
  const results = await Promise.allSettled(lanes.map(lane => runLane({...options, base: 'https://hokko.goryachkinstudio.chatgpt.site', lane})));
  for (let i = 0; i < results.length; i++) if (results[i].status === 'rejected') { console.error(JSON.stringify({lane: lanes[i], status: 'failed', error: String(results[i].reason.message).replaceAll(options.key || 'no-key', '[redacted]')})); process.exitCode = 1; }
}
