import { createBridge, onFromIsolated, sendToIsolated } from '@src/lib/broadcast-bridge';

export const startYouTubeMainContentScript = (): (() => void) => {
  const channel = createBridge(window.location.href);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageWindow = window as any;

  const extractAndRelayPlayerResponse = () => {
    const playerResponse = pageWindow.ytInitialPlayerResponse;
    if (!playerResponse?.streamingData) return false;
    sendToIsolated(channel, { name: 'youtube_player_response', data: { playerResponse } });
    return true;
  };

  const stopBridge = onFromIsolated(channel, msg => {
    if (msg.name === 'youtube_request_player_response') extractAndRelayPlayerResponse();
  });

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };
  if (!extractAndRelayPlayerResponse()) {
    schedule(() => {
      if (!extractAndRelayPlayerResponse()) {
        schedule(extractAndRelayPlayerResponse, 2000);
      }
    }, 500);
  }
  return () => {
    stopBridge();
    channel.close();
    timers.forEach(clearTimeout);
  };
};
