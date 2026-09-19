import { ipcMain } from "electron";
import { sshConfigSchema } from "../../shared/schemas";
import { normalizeBackendPreference, type OllamaEnvironment, type SshConfig } from "../../shared/types";
import { applyEndpoint, OllamaProbe } from "../ssh/OllamaProbe";
import { SshSession } from "../ssh/SshSession";

const ssh = new SshSession();
let environment: OllamaEnvironment | undefined;

export function registerConnectionIpc(): void {
  ipcMain.handle("connection:connect", async (_event, rawConfig: SshConfig) => {
    const parsed = sshConfigSchema.parse(rawConfig);
    const preference = normalizeBackendPreference(parsed.backendPreference);
    // 归一化后再交给会话，旧版本的 ollama-rocm / llama.cpp-rocm / llama.cpp-vulkan 会被折叠。
    await ssh.connect({ ...parsed, backendPreference: preference });
    const detected = await new OllamaProbe(ssh).detect(preference);
    // 即使一个端点都没连通也把结果交回渲染层：V2.4 在这里直接 throw，导致用户
    // 只能看到一句「not reachable」，候选端点与失败原因全部丢失。现在由界面
    // 展示完整诊断，并禁止在 not-found 状态下进入下一步。
    environment = detected;
    return detected;
  });

  /**
   * 手动切换端点。探测阶段已经把每个候选端点的模型清单与加速状态取回，
   * 因此这里只做数据重绑，不再新增 SSH 通道。
   */
  ipcMain.handle("connection:use-endpoint", async (_event, endpointId: string) => {
    if (!environment) throw new Error("尚未连接服务器，无法切换推理端点。");
    const next = applyEndpoint(environment, String(endpointId ?? ""));
    if (next.endpointId !== endpointId) throw new Error(`端点 ${endpointId} 不可用，请重新探测后再选择。`);
    environment = next;
    return next;
  });

  ipcMain.handle("connection:disconnect", async () => {
    environment = undefined;
    await ssh.close();
  });
}

export function getSshSession(): SshSession {
  return ssh;
}

export function getEnvironment(): OllamaEnvironment | undefined {
  return environment;
}
