// ABOUTME: Allocates distinct ephemeral loopback ports for one Playwright e2e run.
// ABOUTME: Holds every reservation until the complete set exists, then releases them for startup.
import { createServer } from "node:net";

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Reserves `count` distinct OS-assigned loopback ports simultaneously, then releases the complete
 * set immediately before Playwright starts its strict-port servers. If another process wins the
 * post-release race, strict startup fails instead of reusing that foreign server.
 *
 * @param {number} count
 * @returns {Promise<number[]>}
 */
export async function allocateLoopbackPorts(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("e2e loopback port count must be a positive integer");
  }

  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      servers.push(await reserveLoopbackPort());
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("e2e loopback reservation has no TCP address");
      }
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(closeServer));
  }
}
