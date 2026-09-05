import { loadScenarios, reviewedSuiteDirectory } from "@eigen/external-runner";
import { createCodingAgent, createTestDrafter } from "./coding-agent.js";
import { createSandboxEvaluator } from "./evaluation.js";
import { createGitHubProvider } from "./github.js";
import { createE2BProvider } from "./sandbox.js";
import { createPlatformService } from "./service.js";
import { createPostgresStore } from "./store.js";
import type { PlatformSetup } from "./types.js";
import { createPlatformWorker } from "./worker.js";

export async function createPlatformRuntime(env: NodeJS.ProcessEnv) {
  const origin = (
    env.EIGEN_PUBLIC_ORIGIN ??
    `http://127.0.0.1:${env.EIGEN_DASHBOARD_PORT ?? "4173"}`
  ).replace(/\/$/, "");
  const githubKeys = [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "EIGEN_TOKEN_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ];
  const workerKeys = ["E2B_API_KEY", "OPENAI_API_KEY"];
  const missing = ["DATABASE_URL", ...githubKeys, ...workerKeys].filter(
    (key) => !env[key],
  );
  const setup: PlatformSetup = {
    ready: missing.length === 0,
    missing,
    githubReady: githubKeys.every((key) => Boolean(env[key])),
    workerReady: [...githubKeys, ...workerKeys, "DATABASE_URL"].every((key) =>
      Boolean(env[key]),
    ),
  };
  if (!env.DATABASE_URL)
    return {
      origin,
      setup,
      service: undefined,
      worker: undefined,
      close: async () => {},
    };
  const store = createPostgresStore(env.DATABASE_URL);
  try {
    await store.read(() => true);
  } catch {
    await store.close();
    setup.missing.push("Project database migration (pnpm platform:migrate)");
    setup.ready = false;
    setup.workerReady = false;
    return {
      origin,
      setup,
      service: undefined,
      worker: undefined,
      close: async () => {},
    };
  }
  const github = setup.githubReady
    ? createGitHubProvider({
        appId: env.GITHUB_APP_ID ?? "",
        slug: env.GITHUB_APP_SLUG ?? "",
        privateKey: env.GITHUB_APP_PRIVATE_KEY ?? "",
        clientId: env.GITHUB_APP_CLIENT_ID ?? "",
        clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
        origin,
      })
    : undefined;
  const model = env.EIGEN_CODING_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.6-luna";
  const service = createPlatformService({
    store,
    origin,
    model,
    templates: await loadScenarios(reviewedSuiteDirectory),
    setup,
    ...(github ? { github } : {}),
    ...(env.EIGEN_TOKEN_KEY ? { tokenKey: env.EIGEN_TOKEN_KEY } : {}),
    ...(env.GITHUB_WEBHOOK_SECRET
      ? { webhookSecret: env.GITHUB_WEBHOOK_SECRET }
      : {}),
    ...(env.OPENAI_API_KEY
      ? { draft: createTestDrafter(env.OPENAI_API_KEY, model) }
      : {}),
  });
  let worker: ReturnType<typeof createPlatformWorker> | undefined;
  if (setup.workerReady && env.E2B_API_KEY && env.OPENAI_API_KEY) {
    const sandbox = createE2BProvider(
      env.E2B_API_KEY,
      env.E2B_TEMPLATE ?? "base",
    );
    const evaluator = createSandboxEvaluator(sandbox, env.OPENAI_API_KEY);
    worker = createPlatformWorker({
      service,
      evaluator,
      coding: createCodingAgent(sandbox, evaluator, env.OPENAI_API_KEY),
    });
  }
  return {
    origin,
    setup,
    service,
    worker,
    close: async () => {
      await worker?.shutdown();
      await store.close();
    },
  };
}
