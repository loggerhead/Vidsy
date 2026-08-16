import { createBridge, onFromIsolated, sendToIsolated } from '@src/lib/broadcast-bridge';

export const startYouTubeMainContentScript = (): void => {
  const channel = createBridge(window.location.href);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageWindow = window as any;

  const extractAndRelayPlayerResponse = () => {
    const playerResponse = pageWindow.ytInitialPlayerResponse;
    if (!playerResponse?.streamingData) return false;
    sendToIsolated(channel, { name: 'youtube_player_response', data: { playerResponse } });
    return true;
  };

  onFromIsolated(channel, msg => {
    if (msg.name === 'youtube_request_player_response') extractAndRelayPlayerResponse();
  });

  if (!extractAndRelayPlayerResponse()) {
    setTimeout(() => {
      if (!extractAndRelayPlayerResponse()) {
        setTimeout(extractAndRelayPlayerResponse, 2000);
      }
    }, 500);
  }
};
