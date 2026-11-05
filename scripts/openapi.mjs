import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
// Resolve the owned TypeScript contract dependencies without requiring stale build output.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith("./") &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith(
        new URL("../ts-core/src/", import.meta.url).href,
      )
    ) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { buildHiveMemOpenApiSpec } = await import("../ts-core/src/openapi.ts");
import { readFileSync, writeFileSync } from "node:fs";
const file = new URL("../docs/openapi.json", import.meta.url);
const document = buildHiveMemOpenApiSpec();
const expected =
  JSON.stringify(
    document,
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
    2,
  ) + "\n";
if (process.argv.includes("--write")) writeFileSync(file, expected);
else if (readFileSync(file, "utf8") !== expected)
  throw new Error("OpenAPI drift: run npm run generate:openapi");
else console.log("Owned OpenAPI baseline is current");
