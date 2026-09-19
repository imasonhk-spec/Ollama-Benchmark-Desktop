import { describe, expect, it, vi } from "vitest";
import { OllamaProbe } from "./OllamaProbe";

describe("OllamaProbe Docker permission handling", () => {
  it("uses existing sudo access for read-only Docker inspection", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const execPrivileged = vi.fn(async (command: string) => {
      if (command.includes("docker inspect")) return { stdout: "__DOCKER_IP__\n/ollama-rocm 172.18.0.3 ", stderr: "", code: 0 };
      if (command.includes("docker ps")) {
        return { stdout: "__DOCKER__\nabc123\tollama-rocm\tollama/ollama:rocm\t11434/tcp\n__EXIT__0", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const requestJson = vi.fn(async (request: { host: string; path: string }) => {
      if (request.host === "127.0.0.1") throw new Error("connection refused");
      return request.path === "/api/version" ? { version: "0.1" } : { models: [{ name: "demo" }] };
    });

    const environment = await new OllamaProbe({ exec, execPrivileged, requestJson } as never).detect();

    expect(execPrivileged).toHaveBeenCalled();
    expect(environment.deployment).toBe("docker");
    expect(environment.apiHost).toBe("172.18.0.3");
    expect(environment.binary).toBe("ollama");
    expect(environment.warnings.join(" ")).not.toContain("permission denied");
  });

  it("reports permission details without suggesting a server configuration change", async () => {
    const ssh = {
      exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
      execPrivileged: vi.fn(async () => ({
        stdout: "",
        stderr: "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
        code: 1,
      })),
      requestJson: vi.fn(async () => { throw new Error("connection refused"); }),
    } as never;

    const environment = await new OllamaProbe(ssh).detect();
    const diagnostics = environment.warnings.join(" ");
    expect(diagnostics).toContain("Docker 探测失败");
    expect(diagnostics).toContain("未修改服务器任何配置");
  });
});
