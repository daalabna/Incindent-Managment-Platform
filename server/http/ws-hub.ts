import type { WebSocket } from "ws";
import type { ChangeNotice } from "../broker/redis";

/** WebSocket fan-out kept out of app assembly. */
export const createWsHub = () => {
  const clients = new Set<WebSocket>();
  const broadcast = (notice?: ChangeNotice) => {
    const payload = JSON.stringify({
      type: "state.changed",
      scopes: notice?.scopes ?? ["summary", "activity", "incident"],
      incidentId: notice?.incidentId ?? null,
    });
    for (const client of clients)
      if (client.readyState === 1) client.send(payload);
  };
  return {
    clients,
    broadcast,
    add: (socket: WebSocket) => clients.add(socket),
    remove: (socket: WebSocket) => clients.delete(socket),
    closeAll: () => {
      for (const client of clients) client.close();
    },
  };
};
