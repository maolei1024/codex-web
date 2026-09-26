import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function importTypescriptModule(modulePath) {
  const source = await readFile(modulePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}
