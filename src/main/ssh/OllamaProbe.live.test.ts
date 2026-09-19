import { describe, expect, it } from "vitest";
import { OllamaProbe } from "./OllamaProbe";
import { SshSession } from "./SshSession";

/**
 * 真机联通性验证（默认跳过）。
 *
 * 单测用打桩覆盖逻辑，但「端口枚举是否真的能发现同一台机器上的第二个 Ollama 实例」
 * 只有对真实服务器跑一遍才能确认。需要时显式打开：
 *
 *   OLLAMA_LIVE=1 OLLAMA_LIVE_HOST=<server-host> OLLAMA_LIVE_USER=<ssh-user> OLLAMA_LIVE_PASSWORD=<ssh-password> \
 *     npx vitest run src/main/ssh/OllamaProbe.live.test.ts
 *
 * 该用例只执行只读命令（docker ps / ss / ps / lspcu 等），不会修改服务器配置。
 */
const enabled = process.env.OLLAMA_LIVE === "1";

describe.skipIf(!enabled)("live server probe", () => {
  it("enumerates every reachable Ollama endpoint on the target server", async () => {
    const ssh = new SshSession();
    await ssh.connect({
      host: process.env.OLLAMA_LIVE_HOST ?? "127.0.0.1",
      port: Number(process.env.OLLAMA_LIVE_PORT ?? 22),
      username: process.env.OLLAMA_LIVE_USER ?? "root",
      password: process.env.OLLAMA_LIVE_PASSWORD ?? "",
      connectTimeoutMs: 20_000,
    });
    try {
      const environment = await new OllamaProbe(ssh).detect(process.env.OLLAMA_LIVE_BACKEND ?? "ollama");
      const ok = (environment.endpoints ?? []).filter((endpoint) => endpoint.ok);
      // 探测结果的可见性本身就是本用例要验证的东西。
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        selected: `${environment.apiHost}:${environment.apiPort}`,
        backend: environment.backend,
        acceleration: environment.acceleration,
        models: environment.installedModels.length,
        endpoints: (environment.endpoints ?? []).map((endpoint) => ({
          id: endpoint.id, ok: endpoint.ok, source: endpoint.source,
          models: endpoint.models.length, accel: endpoint.acceleration?.mode, detail: endpoint.detail,
        })),
        warnings: environment.warnings,
      }, null, 2));
      expect(environment.deployment).not.toBe("not-found");
      expect(ok.length).toBeGreaterThan(0);
      expect(environment.installedModels.length).toBeGreaterThan(0);
    } finally {
      await ssh.close();
    }
  }, 180_000);

  it("measures per-channel and per-request overhead", async () => {
    const ssh = new SshSession();
    await ssh.connect({
      host: process.env.OLLAMA_LIVE_HOST ?? "127.0.0.1",
      port: Number(process.env.OLLAMA_LIVE_PORT ?? 22),
      username: process.env.OLLAMA_LIVE_USER ?? "root",
      password: process.env.OLLAMA_LIVE_PASSWORD ?? "",
      connectTimeoutMs: 20_000,
    });
    try {
      const execMs = await timeIt(async () => { for (let index = 0; index < 5; index += 1) await ssh.exec("true"); });
      const heavyMs = await timeIt(async () => {
        await ssh.exec("ps -eo pid=,args= >/dev/null 2>&1; timeout 10s rocm-smi --showproductname >/dev/null 2>&1; timeout 10s lspci >/dev/null 2>&1");
      });
      const requestMs = await timeIt(async () => {
        for (let index = 0; index < 5; index += 1) {
          await ssh.requestJson({ host: "127.0.0.1", port: 11434, path: "/api/version", timeoutMs: 10_000 });
        }
      });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        execPerChannelMs: Math.round(execMs / 5),
        heavyCommandMs: heavyMs,
        requestPerCallMs: Math.round(requestMs / 5),
      }, null, 2));
      expect(execMs).toBeGreaterThan(0);
    } finally {
      await ssh.close();
    }
  }, 180_000);
});

async function timeIt(run: () => Promise<void>): Promise<number> {
  const started = Date.now();
  await run();
  return Date.now() - started;
}
