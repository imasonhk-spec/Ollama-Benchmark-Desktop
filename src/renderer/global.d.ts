import type { BenchmarkApi } from "../shared/ipc";

declare global {
  interface Window {
    ollamaBenchmark: BenchmarkApi;
  }
}

export {};
