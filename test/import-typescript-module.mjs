import { readFile } from "node:fs/promises";
import ts from "typescript";
import path from "node:path";

async function moduleUrl(modulePath) {
  const source = await readFile(modulePath, "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  for (const match of [...output.matchAll(/from\s+(["'])(\.[^"']+)\1/g)]) {
    const target = path.resolve(path.dirname(modulePath), match[2].replace(/\.js$/, ".ts"));
    const url = await moduleUrl(path.extname(target) ? target : `${target}.ts`);
    output = output.replace(match[0], `from ${JSON.stringify(url)}`);
  }
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}
export async function importTypescriptModule(modulePath) { return import(await moduleUrl(modulePath)); }
