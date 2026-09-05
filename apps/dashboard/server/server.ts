import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDashboardApi,
  createDefaultDashboardApiDependencies,
} from "./api.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const clientRoot = resolve(repoRoot, "apps/dashboard/dist/client");
const port = Number(process.env.EIGEN_DASHBOARD_PORT ?? "4173");
const api = createDashboardApi(
  createDefaultDashboardApiDependencies(repoRoot, process.env),
);

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    const host = request.headers.host ?? "";
    const hostname = host.split(":")[0];
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Eigen dashboard is available only on this computer.");
      return;
    }
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) bodyChunks.push(Buffer.from(chunk));
    const url = `http://${host}${request.url ?? "/"}`;
    const apiResponse = await api(
      new Request(url, {
        method: request.method ?? "GET",
        headers: request.headers as HeadersInit,
        ...(bodyChunks.length > 0 ? { body: Buffer.concat(bodyChunks) } : {}),
      }),
    );
    if (apiResponse) {
      response.writeHead(
        apiResponse.status,
        Object.fromEntries(apiResponse.headers),
      );
      response.end(Buffer.from(await apiResponse.arrayBuffer()));
      return;
    }
    const pathname = new URL(url).pathname;
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = resolve(clientRoot, relativePath);
    const safeCandidate = candidate.startsWith(`${clientRoot}/`)
      ? candidate
      : resolve(clientRoot, "index.html");
    let source: Buffer;
    let filePath = safeCandidate;
    try {
      source = await readFile(filePath);
    } catch {
      filePath = resolve(clientRoot, "index.html");
      source = await readFile(filePath);
    }
    response.writeHead(200, {
      "Content-Type":
        contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": filePath.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
    });
    response.end(source);
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Eigen dashboard could not complete the request.");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Eigen dashboard: http://127.0.0.1:${port}\n`);
});
