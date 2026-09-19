import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const [major, minor] = String(packageJson.version).split(".");
const displayVersion = `V${major}.${minor}`;
const productName = `Ollama Benchmark_${displayVersion}`;
const windowTitle = `${productName}-${String.fromCodePoint(0x660e, 0x677e)}Mason`;

packageJson.productName = productName;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

const lockPath = join(root, "package-lock.json");
try {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.version = packageJson.version;
  if (lock.packages?.[""]) lock.packages[""].version = packageJson.version;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
} catch {
  // A lockfile is optional for consumers that only use the packaged app.
}

const builderPath = join(root, "electron-builder.yml");
let builder = await readFile(builderPath, "utf8");
builder = builder.replace(/^productName:.*$/m, `productName: ${productName}`);
builder = builder.replace(/^  artifactName:.*$/m, `  artifactName: ${productName}-Setup.${"${ext}"}`);
builder = builder.replace(/^  executableName:.*$/m, `  executableName: ${productName}`);
builder = builder.replace(/^  shortcutName:.*$/m, `  shortcutName: ${productName}`);
await writeFile(builderPath, builder, "utf8");

const mainPath = join(root, "src", "main", "main.ts");
let main = await readFile(mainPath, "utf8");
main = main.replace(/title:\s*"Ollama Benchmark_[^"]*"/, `title: "${windowTitle}"`);
await writeFile(mainPath, main, "utf8");

const indexPath = join(root, "src", "renderer", "index.html");
let index = await readFile(indexPath, "utf8");
index = index.replace(/<title>Ollama Benchmark_[^<]*<\/title>/, `<title>${windowTitle}</title>`);
await writeFile(indexPath, index, "utf8");

const rootIndexPath = join(root, "index.html");
let rootIndex = await readFile(rootIndexPath, "utf8");
rootIndex = rootIndex.replace(/<title>Ollama Benchmark_[^<]*<\/title>/, `<title>${windowTitle}</title>`);
await writeFile(rootIndexPath, rootIndex, "utf8");

console.log(`Branding synchronized to ${displayVersion}`);