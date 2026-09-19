import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { SshSession } from "./SshSession";

describe("SshSession HTTP forwarding", () => {
  it("works with an SSH2 duplex stream that has no socket.setTimeout method", async () => {
    const session = new SshSession();
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); },
    });
    const responseBody = JSON.stringify({ version: "test" });
    const fakeClient = {
      forwardOut: (
        _srcHost: string,
        _srcPort: number,
        _destHost: string,
        _destPort: number,
        callback: (error: Error | undefined, channel: Duplex) => void,
      ) => {
        callback(undefined, stream);
        setImmediate(() => {
          stream.push(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`);
          stream.push(null);
        });
      },
    };
    (session as unknown as { client: unknown }).client = fakeClient;

    await expect(session.requestJson({ host: "172.18.0.3", port: 11434, path: "/api/version", timeoutMs: 1_000 }))
      .resolves.toEqual({ version: "test" });
  });
});
