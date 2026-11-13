import { createLogger } from '@extension/shared';

const log = createLogger('devtools');
log.debug('started');

try {
  chrome.devtools.panels.create('UUGet', '/icon-34.png', '/devtools-panel/index.html');
} catch (e) {
  log.error('panel_creation_failed', e);
}
