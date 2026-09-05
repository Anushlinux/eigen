import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDashboardApi,
  createDefaultDashboardApiDependencies,
} from "./api.js";
import { createDashboardAuth, withDashboardAuth } from "./auth.js";
import { createHostedDashboardAuth } from "./hosted-auth.js";
import { sendWebResponse } from "./node-response.js";
import { createPlatformApi, platformJson } from "./platform/api.js";
import { createPlatformRuntime } from "./platform/runtime.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const clientRoot = resolve(repoRoot, "apps/dashboard/dist/client");
const hosted = process.env.EIGEN_HOSTED === "true";
const port = Number(
  process.env.PORT ?? process.env.EIGEN_DASHBOARD_PORT ?? "4173",
);
const auth =
  process.env.EIGEN_AUTH_MODE === "github"
    ? createHostedDashboardAuth(process.env)
    : createDashboardAuth(process.env);
const invited = (process.env.EIGEN_INVITED_USERS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
if (
  hosted &&
  (!auth ||
    !process.env.EIGEN_PUBLIC_ORIGIN?.startsWith("https://") ||
    !invited.length)
)
  throw new Error(
    "Hosted Eigen requires authentication, an HTTPS EIGEN_PUBLIC_ORIGIN, and EIGEN_INVITED_USERS.",
  );
const platform = await createPlatformRuntime(process.env);
const platformApi = createPlatformApi(
  platform.service,
  platform.setup,
  platform.origin,
);
const dependencies = hosted
  ? undefined
  : createDefaultDashboardApiDependencies(
      resolve(process.env.EIGEN_PROJECT_DIR ?? repoRoot),
      process.env,
    );
await dependencies?.externalJobs?.ready;
const localApi = dependencies ? createDashboardApi(dependencies) : undefined;
const api = withDashboardAuth(async (request, user) => {
  if (!new URL(request.url).pathname.startsWith("/api/")) return undefined;
  if (
    hosted &&
    (!user ||
      (!invited.includes(user.id.toLowerCase()) &&
        !(
          user.emailVerified &&
          invited.includes(user.email?.toLowerCase() ?? "")
        )))
  )
    return platformJson(
      { error: "This hosted pilot is invitation-only." },
      403,
    );
  const result = await platformApi(request, user);
  if (result) return result;
  if (hosted && new URL(request.url).pathname.startsWith("/api/"))
    return platformJson({ error: "Route not found." }, 404);
  return localApi?.(request);
}, auth);

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(platform.service ? 200 : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          status: platform.service ? "ready" : "setup_required",
        }),
      );
      return;
    }
    const host = request.headers.host ?? "";
    const hostname = host.split(":")[0];
    if (
      hosted
        ? host !== new URL(platform.origin).host
        : hostname !== "127.0.0.1" && hostname !== "localhost"
    ) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(
        hosted
          ? "Unexpected request host."
          : "Eigen dashboard is available only on this computer.",
      );
      return;
    }
    const bodyChunks: Buffer[] = [];
    let bodySize = 0;
    for await (const chunk of request) {
      bodySize += chunk.length;
      if (bodySize > 1_000_000) {
        response.writeHead(413);
        response.end("Request too large.");
        return;
      }
      bodyChunks.push(Buffer.from(chunk));
    }
    const url = `${hosted ? platform.origin : `http://${host}`}${request.url ?? "/"}`;
    const incoming = new Request(url, {
      method: request.method ?? "GET",
      headers: request.headers as HeadersInit,
      ...(bodyChunks.length > 0 ? { body: Buffer.concat(bodyChunks) } : {}),
    });
    const route = new URL(url).pathname;
    if (route === "/health") {
      response.writeHead(platform.service ? 200 : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          status: platform.service ? "ready" : "setup_required",
        }),
      );
      return;
    }
    if (route === "/github/setup") {
      response.writeHead(303, { Location: `${platform.origin}/projects/new` });
      response.end();
      return;
    }
    const publicCallback =
      route === "/api/github/callback" || route === "/api/github/webhook";
    const apiResponse = publicCallback
      ? await platformApi(incoming)
      : await api(incoming);
    if (apiResponse) {
      await sendWebResponse(response, apiResponse);
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

server.listen(port, hosted ? "0.0.0.0" : "127.0.0.1", () => {
  process.stdout.write(`Eigen dashboard: http://127.0.0.1:${port}\n`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await dependencies?.externalJobs?.shutdown();
  await platform.close();
  await auth?.close?.();
  server.closeAllConnections();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
