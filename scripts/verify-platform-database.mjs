import { createPostgresStore } from "../apps/dashboard/dist-server/platform/store.js";

const connection = new URL(
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
);
if (!process.env.EIGEN_VERIFY_DATABASE_HOST)
  throw new Error("Set the isolated verification branch hostname explicitly.");
connection.hostname = process.env.EIGEN_VERIFY_DATABASE_HOST;
const ownerId = `database-verification-${Date.now()}`;
let store = createPostgresStore(connection.toString());
try {
  await store.migrate();
  await store.migrate();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.transaction((state) => {
        const id = `${ownerId}-${i}`;
        state.receipts[id] = {
          id,
          ownerId,
          createdAt: new Date().toISOString(),
        };
      }),
    ),
  );
  try {
    await store.transaction((state) => {
      state.receipts[`${ownerId}-rollback`] = {
        id: `${ownerId}-rollback`,
        ownerId,
        createdAt: new Date().toISOString(),
      };
      throw new Error("intentional rollback");
    });
  } catch (error) {
    if (error.message !== "intentional rollback") throw error;
  }
  await store.close();
  store = createPostgresStore(connection.toString());
  const rows = await store.read((state) =>
    Object.values(state.receipts).filter((row) => row.ownerId === ownerId),
  );
  if (rows.length !== 8 || rows.some((row) => row.id.endsWith("-rollback")))
    throw new Error("Persistence verification failed");
  console.log(
    JSON.stringify({
      migrationIdempotent: true,
      concurrentTransactions: 8,
      rollback: true,
      reconnectPersistence: true,
    }),
  );
} catch (error) {
  console.error(
    "Database verification failed:",
    error.code ?? error.name,
    error.stack
      ?.split("\n")
      .filter((line) => line.trim().startsWith("at "))
      .join("\n"),
  );
  process.exitCode = 1;
} finally {
  await store.transaction((state) => {
    for (const [id, row] of Object.entries(state.receipts))
      if (row.ownerId === ownerId) delete state.receipts[id];
  });
  await store.close();
}
