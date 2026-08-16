import { DO_UPDATE, DONE_UPDATE, LOCAL_RELOAD_SOCKET_URL } from '../consts.js';
import MessageInterpreter from '../interpreter/index.js';

export default ({ id, onUpdate }: { id: string; onUpdate: () => boolean | void }) => {
  const ws = new WebSocket(LOCAL_RELOAD_SOCKET_URL);

  ws.onopen = () => {
    ws.addEventListener('message', event => {
      const message = MessageInterpreter.receive(String(event.data));

      if (message.type === DO_UPDATE && message.id === id) {
        // A page that is not the active development/test tab keeps its socket
        // open. It can participate in a later update without being reloaded
        // just because the user switches to it.
        if (onUpdate() !== false) {
          ws.send(MessageInterpreter.send({ type: DONE_UPDATE }));
        }
      }
    });
  };
};
