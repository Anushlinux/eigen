import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { sendWebResponse } from "./node-response.js";

it("delivers independent OAuth state and session cookies through real Node HTTP", async () => {
  const server = createServer((_req, res) => {
    const response = Response.json({ ok: true });
    response.headers.append(
      "Set-Cookie",
      "state=one; HttpOnly; Secure; SameSite=Lax; Path=/",
    );
    response.headers.append(
      "Set-Cookie",
      "session=two; HttpOnly; Secure; SameSite=Lax; Path=/",
    );
    void sendWebResponse(res, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test address");
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
