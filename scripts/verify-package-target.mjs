import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const [major, minor] = String(packageJson.version).split(".");
const versionedName = `Ollama Benchmark_V${major}.${minor}.exe`;
const directory = resolve(process.argv[2] ?? "prepackaged-v11/win-unpacked");

await access(join(directory, versionedName));
const legacyName = `Ollama Benchmark_V${Number(minor) - 1}.exe`;
try {
  await access(join(directory, legacyName));
  throw new Error(`旧版本可执行文件仍存在：${legacyName}`);
} catch (error) {
  if (error instanceof Error && !/不存在|ENOENT|系统找不到/.test(error.message)) throw error;
}
const expectedTitle = `Ollama Benchmark_V${major}.${minor}-明松Mason`;

// Read the main bundle. The app is normally asar-packed (resources/app.asar),
// but fall back to the unpacked layout (resources/app/out/main/main.js) for
// prepackaged / asar:false builds.
async function readMainBundle() {
  const unpacked = join(directory, "resources", "app", "out", "main", "main.js");
  try {
    return await readFile(unpacked, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const asarPath = join(directory, "resources", "app.asar");
  const require = createRequire(import.meta.url);
  const { extractFile } = require("@electron/asar");
  // asar headers on Windows store entry paths with backslashes.
  const candidates = ["out/main/main.js", "out\\main\\main.js"];
  let content;
  let lastErr;
  for (const c of candidates) {
    try {
      const r = await extractFile(asarPath, c);
      if (r) {
        content = r;
        lastErr = null;
        break;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (!content) throw lastErr ?? new Error("无法从 app.asar 读取主进程包");
  return Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
}

const mainBundle = await readMainBundle();
if (!mainBundle.includes(expectedTitle)) throw new Error(`主进程资源不是当前版本：${join(directory, "resources", "app.asar")}`);
try { await access(join(directory, "resources", "app", "out", "out")); throw new Error("检测到嵌套 out 目录，可能打包时复制了旧版本资源"); } catch (error) { if (error instanceof Error && !/不存在|ENOENT|系统找不到/.test(error.message)) throw error; }
console.log(`Package target OK: ${join(directory, versionedName)}`);
