import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseScenario, type Scenario } from "@eigen/core";
import { parse as parseYaml } from "yaml";

export async function loadScenarios(
  directoryPath: string,
): Promise<Scenario[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const names = entries
    .filter(
      (entry) =>
        entry.isFile() && [".yaml", ".yml"].includes(extname(entry.name)),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0)
    throw new Error(`No YAML scenarios found in ${directoryPath}`);
  const scenarios = await Promise.all(
    names.map(async (name) =>
      parseScenario(
        parseYaml(await readFile(resolve(directoryPath, name), "utf8")),
      ),
    ),
  );
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id))
      throw new Error(`Duplicate scenario ID: ${scenario.id}`);
    seen.add(scenario.id);
  }
  return scenarios;
}
