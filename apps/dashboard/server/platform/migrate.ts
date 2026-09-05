import { createPostgresStore } from "./store.js";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url)
  throw new Error("Configure DATABASE_URL_UNPOOLED before running migrations.");
const store = createPostgresStore(url);
try {
  await store.migrate();
  process.stdout.write("Eigen platform database migrations 1–3 applied.\n");
} finally {
  await store.close();
}
