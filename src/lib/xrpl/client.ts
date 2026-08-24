import { Client } from "xrpl";
import { resolveServerNetwork } from "./networks";

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

/** Client XRPL partagé côté serveur. Singleton avec reconnexion + retry. */
export async function getClient(): Promise<Client> {
  if (client?.isConnected()) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // déjà tombé, on repart propre
      }
      client = null;
    }

    const { wsUrl } = resolveServerNetwork();
    const next = new Client(wsUrl, { connectionTimeout: 20000, timeout: 30000 });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await next.connect();
        client = next;
        return next;
      } catch (error) {
        if (attempt === 3) {
          client = null;
          throw error;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error("unreachable");
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function disconnectClient(): Promise<void> {
  if (connecting) {
    try {
      await connecting;
    } catch {
      // ignore
    }
  }
  if (client?.isConnected()) await client.disconnect();
  client = null;
}
