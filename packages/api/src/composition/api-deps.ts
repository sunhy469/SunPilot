import type { AgentService } from "@sunpilot/core";
import type { DatabaseContext, SunPilotPaths } from "@sunpilot/storage";
import type { OssClient } from "../storage/oss-client.js";

/**
 * API 层依赖接口 — API 只能依赖这个接口，不依赖 daemon 进程对象。
 * daemon 在挂载 API 时负责提供这些具体实现。
 */
export interface SunPilotApiDeps {
  database: DatabaseContext;
  paths: SunPilotPaths;
  getChatAgent(): Promise<
    Pick<
      AgentService,
      | "handleChatCommand"
      | "stopChat"
      | "cancelRun"
      | "resumeRun"
      | "retryRun"
      | "approve"
      | "reject"
    >
  >;
  skills: {
    reload(): Promise<unknown>;
    list(): unknown[];
    setEnabled(id: string, enabled: boolean): Promise<unknown>;
  };
  config: {
    read(): unknown;
    update(input: unknown): unknown;
  };
  /** Optional OSS client — created once at startup, shared across requests. */
  oss?: OssClient;
}
