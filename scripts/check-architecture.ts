import { ArchitectureModelManager } from "../src/architecture-model.js";
import { SerenaSemanticManager } from "../src/serena-semantic.js";

const semantic = process.argv.includes("--semantic") ? new SerenaSemanticManager() : undefined;
const manager = new ArchitectureModelManager({ semantic });
const issues = await manager.conformance(process.cwd(), { semantic: Boolean(semantic) });
const errors = issues.filter((issue) => issue.severity === "error");
const warnings = issues.filter((issue) => issue.severity === "warning");

for (const item of issues) {
  console.log(`${item.severity} ${item.code}: ${item.message}`);
}
console.log(`Architecture conformance: ${errors.length} error(s), ${warnings.length} warning(s).`);
if (errors.length > 0) process.exitCode = 1;
await semantic?.close();
