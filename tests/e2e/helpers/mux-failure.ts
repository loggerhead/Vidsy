import { expect } from 'vitest';
import type { Page } from 'playwright';

export const injectNextMuxFailure = async (page: Page) => {
  const browser = page.context().browser();
  expect(browser).not.toBeNull();
  const cdp = await browser!.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(
    target => target.type === 'background_page' && target.url.endsWith('/offscreen.html'),
  );
  expect(target).toBeDefined();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target!.targetId, flatten: false });
  const injected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker injection timed out')), 10_000);
    cdp.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
      else resolve();
    });
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: 2, method: 'Runtime.enable' }),
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: 3, method: 'Runtime.runIfWaitingForDebugger' }),
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
  const post = Worker.prototype.postMessage;
  let fail = true;
  Worker.prototype.postMessage = function(message, ...args) {
    if (fail && message.type === 'mux') {
      fail = false;
      message = { ...message, input: { ...message.input, urls: ['jsfetch:blob:invalid-m0-input'] } };
    }
    return post.call(this, message, ...args);
  };
  return true;
})()`,
        returnByValue: true,
      },
    }),
  });
  await injected;
  return cdp;
};
