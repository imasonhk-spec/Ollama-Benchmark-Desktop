import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { SshConfig } from "../../shared/types";

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type StreamRequest = {
  host: string;
  port: number;
  path: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 额外请求头；鉴权头由会话统一注入，通常不需要手动传。 */
  headers?: Record<string, string>;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function needsSudoPassword(result: ExecResult): boolean {
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /password is required|terminal is required|must have a tty|permission denied|not in the sudoers/.test(detail);
}

/**
 * 把 HTTP 失败翻译成用户能直接照做的诊断。
 *
 * V2.4 只说 `Ollama HTTP 404`，用户无法判断是「端口被别的服务占了」还是
 * 「路径不对」；这里补上状态短语、被占用的迹象与 401/403 的处置建议。
 */
export function describeHttpFailure(statusCode: number, statusMessage: string | undefined, bodySample: string | undefined, path: string): string {
  const status = `HTTP ${statusCode}${statusMessage ? ` ${statusMessage}` : ""}`;
  const sample = bodySample?.trim().replace(/\s+/g, " ").slice(0, 120);
  if (statusCode === 401 || statusCode === 403) {
    return `${status}（${path}）：该端点要求鉴权，请在连接表单的「API Key」里填写访问令牌后重试。`;
  }
  if (statusCode === 404) {
    const looksLikeWebServer = Boolean(sample && /<!doctype|<html|<title|spring|whitelabel|nginx|apache/i.test(sample));
    return `${status}（${path}）：端点不存在${looksLikeWebServer ? "，且响应是网页内容——该端口很可能被其它 Web 服务占用，不是推理服务" : ""}。${sample ? ` 响应片段：${sample}` : ""}`;
  }
  return `${status}（${path}）${sample ? `：${sample}` : ""}`;
}

export class SshSession {
  private client: Client | undefined;
  private sudoPassword: string | undefined;
  public requestedApiPort: number | undefined;
  /** 用户在连接表单里指定的推理服务主机（相对 SSH 服务器）。 */
  public requestedApiHost: string | undefined;
  /** 用户在连接表单里填写的 API Key；非空时所有请求自动带 Bearer 头。 */
  public requestedApiKey: string | undefined;

  public get connected(): boolean {
    return this.client !== undefined;
  }

  public async connect(config: SshConfig): Promise<void> {
    await this.close();
    const auth: Pick<ConnectConfig, "password" | "privateKey"> = {};
    if (config.password) auth.password = config.password;
    if (config.privateKey) auth.privateKey = config.privateKey.includes("BEGIN")
      ? config.privateKey
      : await readFile(config.privateKey);

    await new Promise<void>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const fail = (reason: unknown) => {
        if (!settled) {
          settled = true;
          reject(asError(reason));
        }
      };
      client.once("ready", () => {
        settled = true;
        this.client = client;
        this.sudoPassword = config.password;
        this.requestedApiPort = config.apiPort;
        this.requestedApiHost = config.apiHost;
        this.requestedApiKey = config.apiKey;
        resolve();
      });
      client.once("error", fail);
      const connectOptions: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.connectTimeoutMs,
        ...auth,
      };
      client.connect(connectOptions);
    });
  }

  public async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.sudoPassword = undefined;
    this.requestedApiPort = undefined;
    this.requestedApiHost = undefined;
    this.requestedApiKey = undefined;
    client?.end();
  }

  /**
   * 所有推理请求共享的请求头。
   *
   * 带鉴权的端点（例如用 API Key 保护的反向代理 / llama-swap）在 V2.4 里只会表现为
   * 「连接失败」，用户完全不知道是缺 Key；这里统一注入后，401/403 会被明确报出来。
   */
  private authHeaders(): Record<string, string> {
    const key = this.requestedApiKey?.trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  public async exec(command: string, timeoutMs = 30_000, input?: string): Promise<ExecResult> {
    const client = this.requireClient();
    return new Promise<ExecResult>((resolve, reject) => {
      let channel: ClientChannel | undefined;
      let stdout = "";
      let stderr = "";
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        channel?.close();
        reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command.slice(0, 300)}`));
      }, timeoutMs);

      client.exec(command, (error, openedChannel) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        channel = openedChannel;
        channel.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
        channel.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
        channel.once("close", (code: number | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
        if (input !== undefined) channel.end(input);
      });
    });
  }

  /**
   * Runs a read-only inspection command with the SSH user's existing sudo rights.
   * It never changes group membership, Docker configuration, or service state.
   */
  public async execPrivileged(command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const direct = await this.exec(`sudo -n -- sh -c ${shellQuote(command)}`, timeoutMs);
    if (direct.code === 0 || !this.sudoPassword || !needsSudoPassword(direct)) return direct;
    return this.exec(`sudo -S -p '' -- sh -c ${shellQuote(command)}`, timeoutMs, `${this.sudoPassword}\n`);
  }

  public async requestJson<T>(request: StreamRequest): Promise<T> {
    let finalValue: T | undefined;
    await this.requestStreamLines(request, (value) => { finalValue = value as T; });
    if (finalValue === undefined) throw new Error("Remote API returned no JSON");
    return finalValue;
  }

  public async requestStreamLines(
    request: StreamRequest,
    onLine: (value: unknown) => void,
  ): Promise<void> {
    const client = this.requireClient();
    const socket = await new Promise<Duplex>((resolve, reject) => {
      client.forwardOut("127.0.0.1", 0, request.host, request.port, (error, stream) => {
        if (error) reject(error);
        else resolve(stream);
      });
    });

    const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      // 非 JSON 响应（例如端口被别的服务占用时返回的 HTML 错误页）不再立刻中断，
      // 而是记下样本等响应结束后统一判断，这样能报出真实的 HTTP 状态码而不是
      // 让人误以为「API 返回了坏 JSON」。
      let nonJsonSample: string | undefined;
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let req: ReturnType<typeof httpRequest> | undefined;
      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (request.signal) request.signal.removeEventListener("abort", abortRequest);
        socket.removeListener("error", onSocketError);
        socket.removeListener("close", onSocketClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onSocketError = (error: Error) => finish(error);
      const onSocketClose = () => {
        if (!settled) finish(new Error("SSH forwarding channel closed before Ollama response"));
      };
      const failAndDestroy = (error: Error) => {
        socket.destroy();
        req?.destroy(error);
        finish(error);
      };
      const abortRequest = () => failAndDestroy(new Error("Ollama request cancelled"));

      socket.once("error", onSocketError);
      socket.once("close", onSocketClose);
      req = httpRequest({
        host: "127.0.0.1",
        port: request.port,
        path: request.path,
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Host: `${request.host}:${request.port}`,
          Connection: "close",
          ...this.authHeaders(),
          ...(request.headers ?? {}),
          ...(payload === undefined ? {} : {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }),
        },
        createConnection: () => socket,
      }, (response: IncomingMessage) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          // 非 JSON 响应体不做无界累积（HTML 错误页可能很大）。
          if (nonJsonSample !== undefined && buffer.length > 8_192) buffer = buffer.slice(-8_192);
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const payloadLine = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            if (payloadLine === "[DONE]") continue;
            try { onLine(JSON.parse(payloadLine)); }
            catch { nonJsonSample ??= payloadLine.slice(0, 200); }
          }
        });
        response.once("end", () => {
          const trimmed = buffer.trim();
          if (trimmed) {
            const payloadLine = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            if (payloadLine !== "[DONE]") {
              try { onLine(JSON.parse(payloadLine)); }
              catch { nonJsonSample ??= payloadLine.slice(0, 200); }
            }
          }
          if (response.statusCode && response.statusCode >= 400) {
            finish(new Error(describeHttpFailure(response.statusCode, response.statusMessage, nonJsonSample, request.path)));
          } else if (nonJsonSample !== undefined) {
            finish(new Error(`Remote API returned invalid JSON: ${nonJsonSample}`));
          } else {
            finish();
          }
        });
        response.once("error", (error) => finish(error));
      });
      timeoutTimer = setTimeout(() => {
        failAndDestroy(new Error(`Ollama request timed out after ${request.timeoutMs ?? 600_000}ms`));
      }, request.timeoutMs ?? 600_000);
      req?.once("error", (error) => finish(error));
      if (request.signal?.aborted) {
        abortRequest();
        return;
      }
      request.signal?.addEventListener("abort", abortRequest, { once: true });
      if (payload !== undefined) req?.write(payload);
      req?.end();
    });
  }

  private requireClient(): Client {
    if (!this.client) throw new Error("SSH is not connected");
    return this.client;
  }
}