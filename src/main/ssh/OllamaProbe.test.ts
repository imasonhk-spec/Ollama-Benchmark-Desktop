import { describe, expect, it, vi } from "vitest";
import type { ProbeEndpoint } from "../../shared/types";
import {
  OllamaProbe,
  accelerationFromArgv,
  accelerationFromOllamaPs,
  applyEndpoint,
  classifyGpu,
  inferLlamaPorts,
  inferOllamaPorts,
  mappedPort,
  normalizeBindHost,
  parseContainerIps,
  parseDockerContainers,
  parseDockerSection,
  parseListeningPorts,
  parseMarkedSections,
  parseProcesses,
  selectDefaultEndpoint,
  stripShellNoise,
} from "./OllamaProbe";

/**
 * 探测现在只发两条合并命令（非特权 + Docker），测试桩按标记生成输出即可，
 * 不必再为每条系统命令单独打桩。
 */
const SECTION_ORDER = ["LISTEN", "PROC", "BIN_OLLAMA", "BIN_LLAMA", "GPU_ROCM", "GPU_LSPCI", "GPU_NVIDIA", "OS", "UNAME", "ARCH", "CPU", "CORES", "MEM", "DISK"] as const;

function probeOutput(parts: Partial<Record<(typeof SECTION_ORDER)[number], string>> = {}): string {
  return SECTION_ORDER.map((key) => `__${key}__\n${parts[key] ?? ""}`).join("\n");
}

function dockerOutput(containers: string, code = 0): string {
  return `__DOCKER__\n${containers}${containers ? "\n" : ""}__EXIT__${code}`;
}

function okEndpoint(overrides: Partial<ProbeEndpoint> & { id: string; port: number }): ProbeEndpoint {
  return {
    backend: "ollama",
    host: "127.0.0.1",
    deployment: "native",
    source: "默认候选端口",
    ok: true,
    detail: "",
    models: [],
    ...overrides,
  };
}

describe("OllamaProbe", () => {
  it("parses Docker IPv6 port mappings", () => {
    expect(mappedPort(":::11434->11434/tcp")).toBe(11434);
    expect(mappedPort("[::]:11434->11434/tcp")).toBe(11434);
    expect(parseDockerContainers("abc\tollama\tollama/ollama:latest\t0.0.0.0:11434->11434/tcp")).toHaveLength(1);
  });

  it("finds a Docker Ollama API through the container IP", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("docker inspect")) return { stdout: "__DOCKER_IP__\n/ollama-rocm 172.18.0.3 ", stderr: "", code: 0 };
      if (command.includes("__DOCKER__")) return { stdout: dockerOutput("abc123\tollama-rocm\tollama/ollama:rocm\t11434/tcp"), stderr: "", code: 0 };
      return { stdout: probeOutput(), stderr: "", code: 0 };
    });
    const requestJson = vi.fn(async (request: { host: string; path: string }) => {
      if (request.host === "127.0.0.1") throw new Error("connection refused");
      return request.path === "/api/tags" ? { models: [{ name: "demo" }] } : { models: [] };
    });
    const environment = await new OllamaProbe({ exec, requestJson } as never).detect();
    expect(environment.deployment).toBe("docker");
    // V2.5：不再从镜像名推断 ROCm 构建变体，运行程序统一是 ollama，加速状态单独实测。
    expect(environment.binary).toBe("ollama");
    expect(environment.apiHost).toBe("172.18.0.3");
    expect(environment.installedModels).toEqual(["demo"]);
    expect(environment.acceleration?.mode).toBe("unknown");
  });

  it("keeps environment detection below a restrictive SSH channel limit", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const exec = vi.fn(async (command: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (inFlight > 3) throw new Error("(SSH) Channel open failure: open failed");
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        if (command.includes("__DOCKER__")) return { stdout: dockerOutput(""), stderr: "", code: 0 };
        return { stdout: probeOutput({ BIN_OLLAMA: "/usr/bin/ollama", OS: "Ubuntu 24.04 LTS", UNAME: "Linux 6.8 x86_64 GNU/Linux", ARCH: "x86_64", CPU: "Test CPU", CORES: "8", MEM: "17179869184", DISK: "536870912000 268435456000" }), stderr: "", code: 0 };
      } finally {
        inFlight -= 1;
      }
    });
    const requestJson = vi.fn(async (request: { path: string }) => request.path === "/api/tags" ? { models: [] } : { models: [] });

    const environment = await new OllamaProbe({ exec, requestJson } as never).detect();

    expect(environment.deployment).toBe("native");
    // 合并命令的意义就在这里：探测只开 2 个通道（原来 16 个），峰值必须压在限流之下。
    expect(peakInFlight).toBeLessThanOrEqual(3);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("collects readonly server system information for the report", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("__DOCKER__")) return { stdout: dockerOutput(""), stderr: "", code: 0 };
      return {
        stdout: probeOutput({
          BIN_OLLAMA: "/usr/bin/ollama",
          OS: "Ubuntu 24.04 LTS",
          UNAME: "Linux 6.8.0 x86_64 GNU/Linux",
          ARCH: "x86_64",
          CPU: "AMD EPYC 9654",
          CORES: "96",
          MEM: String(128 * 1024 ** 3),
          DISK: `${2 * 1024 ** 4} ${1024 ** 4}`,
        }),
        stderr: "",
        code: 0,
      };
    });
    const requestJson = vi.fn(async () => ({ models: [] }));

    const environment = await new OllamaProbe({ exec, requestJson } as never).detect();

    expect(environment.systemInfo).toMatchObject({
      osName: "Ubuntu 24.04 LTS",
      cpuModel: "AMD EPYC 9654",
      cpuCores: 96,
      memoryBytes: 128 * 1024 ** 3,
      storageTotalBytes: 2 * 1024 ** 4,
      storageAvailableBytes: 1024 ** 4,
    });
  });

  it("reports useful diagnostics when no endpoint responds", async () => {
    const ssh = {
      exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 1 })),
      requestJson: vi.fn(async () => { throw new Error("offline"); }),
    } as never;
    const environment = await new OllamaProbe(ssh).detect();
    expect(environment.deployment).toBe("not-found");
    expect(environment.warnings.join(" ")).toContain("Ollama");
    // 每个候选端点的失败原因都必须出现在 warnings 里，而不是只留一句「不可达」。
    expect(environment.endpoints?.length).toBeGreaterThan(1);
    expect(environment.warnings.filter((warning) => warning.includes("offline")).length).toBeGreaterThan(1);
  });

  it("enumerates every reachable endpoint instead of returning the first hit", async () => {
    // 复现线上现象：11434 有 25 个模型，11438 只有 1 个；
    // V2.4 会 first-match-return，用户完全不知道另一个端点的存在。
    const exec = vi.fn(async () => ({ stdout: probeOutput(), stderr: "", code: 0 }));
    const requestJson = vi.fn(async (request: { port: number; path: string }) => {
      if (request.port === 11434) {
        if (request.path === "/api/tags") return { models: [{ name: "a" }, { name: "b" }, { name: "c" }] };
        return { models: [{ name: "a", size: 1_000, size_vram: 1_000 }] };
      }
      if (request.port === 11438) {
        if (request.path === "/api/tags") return { models: [{ name: "qwen3.8:27b" }] };
        return { models: [] };
      }
      throw new Error("connection refused");
    });

    const environment = await new OllamaProbe({ exec, requestJson } as never).detect("ollama");

    const reachable = (environment.endpoints ?? []).filter((endpoint) => endpoint.ok);
    expect(reachable.map((endpoint) => endpoint.port).sort((a, b) => a - b)).toEqual([11434, 11438]);
    expect(environment.apiPort).toBe(11434);
    expect(environment.installedModels).toHaveLength(3);
    expect(environment.acceleration?.mode).toBe("gpu");
    // 模型清单不一致时必须明确告知，而不是静默换掉评测对象。
    expect(environment.warnings.join(" ")).toContain("模型清单不一致");
    expect(environment.warnings.join(" ")).toContain("11438");
  });

  it("treats the V2.4 ollama-rocm preference as plain Ollama and still enumerates all instances", async () => {
    const exec = vi.fn(async () => ({ stdout: probeOutput(), stderr: "", code: 0 }));
    const requestJson = vi.fn(async (request: { port: number; path: string }) => {
      if (request.port !== 11438) throw new Error("connection refused");
      return request.path === "/api/tags" ? { models: [{ name: "qwen3.8:27b" }] } : { models: [] };
    });
    const environment = await new OllamaProbe({ exec, requestJson } as never).detect("ollama-rocm");
    expect(environment.preference).toBe("ollama");
    expect(environment.backend).toBe("ollama");
    expect(environment.apiPort).toBe(11438);
    expect(environment.installedModels).toEqual(["qwen3.8:27b"]);
  });

  it("always surfaces per-endpoint failures, including authentication hints", async () => {
    const exec = vi.fn(async () => ({ stdout: probeOutput(), stderr: "", code: 0 }));
    const requestJson = vi.fn(async () => {
      throw new Error("HTTP 401 Unauthorized（/v1/models）：该端点要求鉴权，请在连接表单的「API Key」里填写访问令牌后重试。");
    });
    const environment = await new OllamaProbe({ exec, requestJson } as never).detect("llama.cpp");
    expect(environment.deployment).toBe("not-found");
    expect(environment.warnings.filter((warning) => warning.includes("401")).length).toBeGreaterThan(1);
    expect(environment.warnings.join(" ")).toContain("API Key");
  });

  it("probes the port discovered in the process and listen tables instead of guessing", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("__DOCKER__")) return { stdout: dockerOutput(""), stderr: "", code: 0 };
      return {
        stdout: probeOutput({
          LISTEN: '127.0.0.1:8082\tusers:(("node",pid=4242,fd=20))',
          PROC: "4242 node /opt/llama-swap/llama-swap --port 8082",
        }),
        stderr: "",
        code: 0,
      };
    });
    const requestJson = vi.fn(async (request: { port: number; path: string }) => {
      if (request.port === 8082 && request.path === "/v1/models") return { data: [{ id: "qwen.gguf" }] };
      throw new Error("connection refused");
    });

    const environment = await new OllamaProbe({ exec, requestJson } as never).detect("llama.cpp");

    expect(environment.apiPort).toBe(8082);
    expect(environment.installedModels).toEqual(["qwen.gguf"]);
    expect(environment.endpoints?.find((endpoint) => endpoint.port === 8082)?.source).toContain("pid 4242");
  });

  it("reports llama.cpp as CPU when the server was started with -ngl 0", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("__DOCKER__")) return { stdout: dockerOutput(""), stderr: "", code: 0 };
      return {
        stdout: probeOutput({
          LISTEN: '127.0.0.1:8082\tusers:(("llama-server",pid=77,fd=3))',
          PROC: "77 llama-server -m /models/x.gguf -ngl 0 --port 8082",
        }),
        stderr: "",
        code: 0,
      };
    });
    const requestJson = vi.fn(async (request: { port: number; path: string }) => {
      if (request.port === 8082 && request.path === "/v1/models") return { data: [{ id: "x.gguf" }] };
      throw new Error("connection refused");
    });
    const environment = await new OllamaProbe({ exec, requestJson } as never).detect("llama.cpp");
    expect(environment.acceleration?.mode).toBe("cpu");
    expect(environment.acceleration?.detail).toContain("-ngl 0");
  });
});

describe("merged command parsing", () => {
  it("splits marked output into sections", () => {
    const sections = parseMarkedSections("__LISTEN__\n127.0.0.1:11434\tusers:((\"ollama\",pid=9,fd=3))\n__PROC__\n9 ollama serve");
    expect(sections.LISTEN).toContain("11434");
    expect(sections.PROC).toBe("9 ollama serve");
  });

  it("reads docker ps output and its exit code from one section", () => {
    const ok = parseMarkedSections("__DOCKER__\nabc\tollama\tollama/ollama:rocm\t11434/tcp\n__EXIT__0");
    expect(parseDockerSection(ok.DOCKER)).toEqual({ code: 0, output: "abc\tollama\tollama/ollama:rocm\t11434/tcp" });
    const failed = parseMarkedSections("__DOCKER__\npermission denied\n__EXIT__1");
    expect(parseDockerSection(failed.DOCKER).code).toBe(1);
    expect(parseDockerSection(failed.DOCKER).output).toBe("permission denied");
  });

  it("parses container names to IPs from a single batched docker inspect", () => {
    const ips = parseContainerIps("/ollama-host 172.18.0.2 \n/strix-llm 172.18.0.5 ");
    expect(ips.get("ollama-host")).toBe("172.18.0.2");
    expect(ips.get("strix-llm")).toBe("172.18.0.5");
  });

  it("strips bash locale noise from probe output", () => {
    const noisy = "bash: warning: setlocale: LC_ALL: cannot change locale (zh_CN.UTF-8)\n__LISTEN__\n127.0.0.1:11434";
    expect(stripShellNoise(noisy)).not.toContain("setlocale");
    expect(stripShellNoise(noisy)).toContain("11434");
  });

  it("parses ss and netstat style listeners", () => {
    const ss = parseListeningPorts('0.0.0.0:11434\tusers:(("ollama",pid=11,fd=3))\n127.0.0.1:8082\tusers:(("node",pid=12,fd=20))');
    expect(ss).toEqual([
      { port: 11434, bind: "0.0.0.0", pid: 11, process: "ollama" },
      { port: 8082, bind: "127.0.0.1", pid: 12, process: "node" },
    ]);
    const netstat = parseListeningPorts("127.0.0.1:11434\t1234/ollama");
    expect(netstat[0]).toMatchObject({ port: 11434, pid: 1234, process: "ollama" });
  });

  it("infers Ollama ports from OLLAMA_HOST, shim processes and the listen table", () => {
    const listening = parseListeningPorts('127.0.0.1:11436\tusers:(("ollama",pid=11,fd=3))');
    const processes = parseProcesses("11 ollama serve");
    expect(inferOllamaPorts(processes, listening).sort((a, b) => a - b)).toEqual([11434, 11436]);

    const custom = parseProcesses("12 OLLAMA_HOST=127.0.0.1:11500 ollama serve");
    expect(inferOllamaPorts(custom, []).sort((a, b) => a - b)).toEqual([11434, 11500]);

    // 实测：11435 是 node 写的 shim，进程名不含 ollama，但命令行含。
    const shimListening = parseListeningPorts('127.0.0.1:11435\tusers:(("MainThread",pid=21,fd=3))');
    const shim = parseProcesses("21 node /opt/dsh-ollama-shim/index.js --ollama-port 11435");
    expect(inferOllamaPorts(shim, shimListening)).toEqual([11435]);
  });

  it("infers llama.cpp ports from --port / -p and the listen table, never from ollama", () => {
    expect(inferLlamaPorts(parseProcesses("77 llama-server -m x.gguf -p 8090"), [])).toEqual([8090]);
    expect(inferLlamaPorts(parseProcesses("77 llama-swap --port 8082"), [])).toEqual([8082]);
    const listening = parseListeningPorts('127.0.0.1:9000\tusers:(("llama-server",pid=88,fd=3))');
    expect(inferLlamaPorts(parseProcesses("88 llama-server -m x.gguf"), listening)).toEqual([9000]);
    // "ollama" 里含 "llama"，不能被当成 llama.cpp。
    expect(inferLlamaPorts(parseProcesses("99 ollama serve"), parseListeningPorts('127.0.0.1:11434\t1234/ollama'))).toEqual([]);
  });

  it("normalizes bind addresses into tunnel-forwardable hosts", () => {
    expect(normalizeBindHost("0.0.0.0")).toBe("127.0.0.1");
    expect(normalizeBindHost("[::]")).toBe("127.0.0.1");
    expect(normalizeBindHost(undefined)).toBe("127.0.0.1");
    expect(normalizeBindHost("192.168.6.90")).toBe("192.168.6.90");
  });
});

describe("GPU classification", () => {
  it("detects AMD from real Strix Halo lspci output (V2.4 word-order regex missed it)", () => {
    const result = classifyGpu({ lspci: "c4:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Strix [Radeon 8060S] (rev c1)" });
    expect(result.vendor).toBe("amd");
    expect(result.models.join(" ")).toContain("Radeon 8060S");
  });

  it("prefers the rocm-smi card series and drops vendor / hex-id noise", () => {
    const result = classifyGpu({
      rocm: "GPU[0]\t\t: Card series: \t\tRadeon 8060S Graphics\nGPU[0]\t\t: Card vendor: \t\tAdvanced Micro Devices, Inc. [AMD/ATI]\nGPU[0]\t\t: Card model: \t\t0x150e",
    });
    expect(result.vendor).toBe("amd");
    expect(result.models).toEqual(["Radeon 8060S Graphics"]);
  });

  it("reports none when the machine has no display device", () => {
    expect(classifyGpu({ lspci: "00:1f.3 Audio device: Intel Corporation Raptor Lake High Definition Audio Controller" }).vendor).toBe("none");
  });

  it("detects NVIDIA from nvidia-smi", () => {
    expect(classifyGpu({ nvidia: "NVIDIA GeForce RTX 4090" }).vendor).toBe("nvidia");
  });
});

describe("acceleration measurement", () => {
  it("reads the real VRAM ratio from /api/ps", () => {
    const info = accelerationFromOllamaPs([{ name: "occamy-1.0-q5", size: 27_600_000_000, size_vram: 27_600_000_000 }]);
    expect(info.mode).toBe("gpu");
    expect(info.vramRatio).toBe(1);
    expect(info.loadedModels).toEqual(["occamy-1.0-q5"]);
  });

  it("reports CPU when nothing landed in VRAM and partial for hybrid offload", () => {
    expect(accelerationFromOllamaPs([{ name: "m", size: 1_000, size_vram: 0 }]).mode).toBe("cpu");
    const partial = accelerationFromOllamaPs([{ name: "m", size: 100, size_vram: 40 }]);
    expect(partial.mode).toBe("partial");
    expect(partial.vramRatio).toBeCloseTo(0.4, 5);
  });

  it("stays undecided when the endpoint is idle", () => {
    const info = accelerationFromOllamaPs([]);
    expect(info.mode).toBe("unknown");
    expect(info.detail).toContain("空闲");
  });

  it("reads llama.cpp acceleration hints from the server command line", () => {
    expect(accelerationFromArgv("llama-server -m x.gguf -ngl 0", "amd").mode).toBe("cpu");
    expect(accelerationFromArgv("llama-server -m x.gguf --n-gpu-layers 99", "amd").mode).toBe("gpu");
    expect(accelerationFromArgv("llama-server --device ROCm0", "amd").mode).toBe("gpu");
    expect(accelerationFromArgv(undefined, "amd").mode).toBe("unknown");
    expect(accelerationFromArgv(undefined, "none").detail).toContain("未检测到 GPU");
  });
});

describe("endpoint selection", () => {
  it("picks the endpoint with the most models and lets the user switch manually", () => {
    const endpoints: ProbeEndpoint[] = [
      okEndpoint({ id: "ollama:127.0.0.1:11434", port: 11434, models: ["a", "b", "c"] }),
      okEndpoint({ id: "ollama:127.0.0.1:11438", port: 11438, models: ["qwen3.8:27b"] }),
      okEndpoint({ id: "ollama:127.0.0.1:11437", port: 11437, ok: false, detail: "connection refused", models: [] }),
    ];
    expect(selectDefaultEndpoint(endpoints)?.port).toBe(11434);

    const environment = {
      deployment: "native" as const,
      binary: "ollama" as const,
      apiHost: "127.0.0.1",
      apiPort: 11434,
      gpuVendor: "amd" as const,
      gpuModels: [],
      installedModels: ["a", "b", "c"],
      warnings: [],
      endpointId: "ollama:127.0.0.1:11434",
      endpoints,
    };
    const switched = applyEndpoint(environment, "ollama:127.0.0.1:11438");
    expect(switched.apiPort).toBe(11438);
    expect(switched.installedModels).toEqual(["qwen3.8:27b"]);
    // 切换失败（端点不存在或不可用）时保持原样，避免把评测对象悄悄换掉。
    expect(applyEndpoint(environment, "ollama:127.0.0.1:11437").apiPort).toBe(11434);
  });
});
