import { setTimeout } from "node:timers/promises";
import { createPlatformRuntime } from "./runtime.js";

const runtime = await createPlatformRuntime(process.env);
if (!runtime.worker) {
  process.stderr.write(
    `Worker setup incomplete: ${runtime.setup.missing.join(", ")}\n`,
  );
  await runtime.close();
  process.exit(1);
}
let running = true;
const shutdown = () => {
  running = false;
  void runtime.worker?.shutdown();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdout.write("Eigen repository worker ready.\n");
while (running) {
  try {
    if (!(await runtime.worker.tick())) await setTimeout(2000);
  } catch {
    process.stderr.write("Worker storage temporarily unavailable; retrying.\n");
    await setTimeout(5000);
  }
}
await runtime.close();
