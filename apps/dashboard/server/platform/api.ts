import { z } from "zod";
import type { AuthUser } from "../auth.js";
import { digest } from "./security.js";
import type { PlatformService } from "./service.js";
import { PlatformError, type PlatformSetup } from "./types.js";

export function platformJson(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
export function createPlatformApi(
  service: PlatformService | undefined,
  setup: PlatformSetup,
  origin: string,
) {
  const required = () => {
    if (!service)
      throw new PlatformError(
        503,
        "Project storage is not configured. Complete the setup panel.",
      );
    return service;
  };
  return async (
    request: Request,
    user?: AuthUser,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      !path.startsWith("/api/projects") &&
      !path.startsWith("/api/github/") &&
      path !== "/api/platform/config"
    )
      return undefined;
    try {
      if (path === "/api/github/webhook" && request.method === "POST") {
        return platformJson(
          await required().webhook(
            await request.text(),
            request.headers.get("x-hub-signature-256") ?? "",
            request.headers.get("x-github-delivery") ?? "",
            request.headers.get("x-github-event") ?? "",
          ),
        );
      }
      if (path === "/api/github/callback" && request.method === "GET") {
        const cookie =
          (request.headers.get("cookie") ?? "")
            .split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith("eigen_github_state="))
            ?.slice("eigen_github_state=".length) ?? "";
        await required().callback(
          url.searchParams.get("code") ?? "",
          url.searchParams.get("state") ?? "",
          cookie,
        );
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${origin}/projects/new`,
            "Set-Cookie": `eigen_github_state=; Path=/api/github; HttpOnly; SameSite=Lax; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (!user)
        return platformJson({ error: "Sign in to access your projects." }, 401);
      if (!["GET", "HEAD"].includes(request.method)) {
        const requestOrigin = request.headers.get("origin");
        if (requestOrigin && requestOrigin !== origin)
          throw new PlatformError(
            403,
            "This request came from an untrusted application origin.",
          );
      }
      if (path === "/api/platform/config" && request.method === "GET")
        return platformJson(
          service
            ? await service.configuration(user)
            : { setup, connection: null, installationUrl: null, templates: [] },
        );
      if (path === "/api/github/connect" && request.method === "POST") {
        const result = await required().connect(user);
        return platformJson({ url: result.url }, 200, {
          "Set-Cookie": `eigen_github_state=${digest(result.state)}; Path=/api/github; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`,
        });
      }
      if (path === "/api/github/repositories" && request.method === "GET")
        return platformJson({
          repositories: await required().repositories(user),
        });
      const branches = path.match(
        /^\/api\/github\/repositories\/(\d+)\/branches$/,
      );
      if (branches && request.method === "GET")
        return platformJson({
          branches: await required().branches(user, Number(branches[1])),
        });
      if (path === "/api/projects") {
        if (request.method === "GET")
          return platformJson({ projects: await required().projects(user) });
        if (request.method === "POST") {
          const body = z
            .object({
              repositoryId: z.number().int().positive(),
              branch: z.string().min(1).max(200),
            })
            .strict()
            .parse(await request.json());
          return platformJson(
            {
              project: await required().createProject(
                user,
                body.repositoryId,
                body.branch,
              ),
            },
            201,
          );
        }
      }
      const match = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
      if (!match?.[1]) return platformJson({ error: "Route not found." }, 404);
      const projectId = decodeURIComponent(match[1]);
      const rest = match[2] ?? "";
      if (rest === "" && request.method === "GET")
        return platformJson(await required().project(user, projectId));
      if (rest === "" && request.method === "PATCH") {
        const body = z
          .object({
            branch: z.string().min(1).max(200).optional(),
            automaticRuns: z.boolean().optional(),
            disconnect: z.boolean().optional(),
          })
          .strict()
          .parse(await request.json());
        return platformJson({
          project: await required().updateProject(user, projectId, body),
        });
      }
      if (rest === "tests" && request.method === "POST") {
        const body = z
          .object({ scenario: z.unknown(), testId: z.string().optional() })
          .strict()
          .parse(await request.json());
        return platformJson(
          {
            test: await required().saveTest(
              user,
              projectId,
              body.scenario,
              body.testId,
            ),
          },
          201,
        );
      }
      if (rest === "tests/draft" && request.method === "POST") {
        const body = z
          .object({ description: z.string().min(10).max(4000) })
          .strict()
          .parse(await request.json());
        return platformJson({
          scenario: await required().draft(user, projectId, body.description),
        });
      }
      const suite = rest.match(/^suites\/([^/]+)$/);
      if (suite?.[1] && request.method === "PATCH") {
        const body = z
          .object({ testVersionIds: z.array(z.string()).min(1).max(30) })
          .strict()
          .parse(await request.json());
        return platformJson({
          suite: await required().saveSuite(
            user,
            projectId,
            suite[1],
            body.testVersionIds,
          ),
        });
      }
      if (rest === "jobs" && request.method === "POST") {
        const body = z
          .object({
            kind: z.enum(["integration", "evaluation", "repair"]),
            testVersionIds: z.array(z.string()).min(1).max(30).optional(),
            pullRequestId: z.string().optional(),
            runId: z.string().optional(),
            force: z.boolean().optional(),
          })
          .strict()
          .parse(await request.json());
        return platformJson(
          { job: await required().run(user, projectId, body) },
          202,
        );
      }
      const cancel = rest.match(/^jobs\/([^/]+)\/cancel$/);
      if (cancel?.[1] && request.method === "POST")
        return platformJson({
          job: await required().cancel(user, projectId, cancel[1]),
        });
      const run = rest.match(/^runs\/([^/]+)$/);
      if (run?.[1] && request.method === "GET")
        return platformJson({
          run: await required().runReport(user, projectId, run[1]),
        });
      return platformJson({ error: "Route not found." }, 404);
    } catch (error) {
      const status =
        error instanceof PlatformError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 502;
      const message =
        error instanceof PlatformError
          ? error.message
          : status === 400
            ? "Invalid request. Check the supplied fields."
            : "The service could not complete this request. Retry or check provider configuration.";
      if (path === "/api/github/callback")
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${origin}/projects/new?error=${encodeURIComponent(message)}`,
            "Cache-Control": "no-store",
          },
        });
      return platformJson({ error: message }, status);
    }
  };
}
