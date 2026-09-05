import type { ServerResponse } from "node:http";

/** Node must receive each Set-Cookie separately, especially during OAuth. */
export async function sendWebResponse(
  target: ServerResponse,
  source: Response,
) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of source.headers)
    if (name !== "set-cookie") headers[name] = value;
  const cookies = source.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  target.writeHead(source.status, headers);
  target.end(Buffer.from(await source.arrayBuffer()));
}
