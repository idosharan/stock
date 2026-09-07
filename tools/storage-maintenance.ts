import { readdirSync } from "node:fs";
import { join } from "node:path";
import { maintainReportStorage } from "../src/report.js";

const excluded = new Set(["node_modules", "node_modules - Copy", ".git"]);

function countFiles(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    if (excluded.has(entry.name)) return total;
    if (entry.isDirectory() && (entry.name.startsWith("github-upload")
      || (dir === root && (entry.name === "_site" || entry.name === ".cache")))) return total;
    if (entry.isDirectory()) return total + countFiles(join(dir, entry.name));
    return total + 1;
  }, 0);
}

const root = process.cwd();
const before = countFiles(root);
const result = await maintainReportStorage(root);
const after = countFiles(root);
console.log(JSON.stringify({ before, after, limit: 100, ...result }, null, 2));
if (result.errors.length > 0 || after > 100) process.exitCode = 1;