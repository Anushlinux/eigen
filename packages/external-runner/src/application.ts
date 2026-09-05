import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const relativeFile = z
  .string()
  .min(1)
  .refine((path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."));
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    entrypoint: relativeFile.refine((path) => path.endsWith(".js")),
    sourceFiles: z.array(relativeFile).min(1).max(100),
  })
  .strict();

export interface ExternalApplication {
  directory: string;
  id: string;
  entrypoint: string;
  files: Record<string, string>;
  contentHash: string;
}

export async function loadExternalApplication(
  directory: string,
): Promise<ExternalApplication> {
  const root = await realpath(directory);
  const checkedPath = async (path: string) => {
    const target = resolve(root, path);
    const canonical = await realpath(target);
    if (
      (await lstat(target)).isSymbolicLink() ||
      relative(root, canonical).startsWith("..")
    )
      throw new Error("Application files must remain inside its directory");
    return target;
  };
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(await checkedPath("eigen.json"), "utf8")),
  );
  const files: Record<string, string> = {};
  const addFile = async (path: string) => {
    if (Object.keys(files).length >= 200)
      throw new Error("Application manifest is too large");
    const target = await checkedPath(path);
    if (
      !(await lstat(target)).isFile() ||
      (await lstat(target)).size > 1_000_000
    )
      throw new Error("Application file is not a bounded regular file");
    files[path] = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
  };
  // Record both source and ALL compiled JS, so changing an imported module
  // changes provenance even when the entrypoint itself stays identical.
  const compiled = async (directoryPath: string): Promise<void> => {
    for (const entry of await readdir(await checkedPath(directoryPath), {
      withFileTypes: true,
    })) {
      const path = `${directoryPath}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error("Compiled application cannot contain symlinks");
      if (entry.isDirectory()) await compiled(path);
      else if (entry.name.endsWith(".js")) await addFile(path);
    }
  };
  for (const file of [
    ...new Set(["eigen.json", ...manifest.sourceFiles, manifest.entrypoint]),
  ])
    await addFile(file);
  await compiled("dist");
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    directory: root,
    id: manifest.id,
    entrypoint: manifest.entrypoint,
    files: sorted,
    contentHash: createHash("sha256")
      .update(JSON.stringify(sorted))
      .digest("hex"),
  };
}
