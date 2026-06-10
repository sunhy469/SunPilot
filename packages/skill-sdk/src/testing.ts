import type { SkillDefinition, SkillHttpRequest, SkillHttpResponse } from "./index.js";
import type { ArtifactRecord } from "@sunpilot/protocol";

export interface TestSkillOptions {
  files?: Record<string, string>;
  secrets?: Record<string, string | undefined>;
  http?: {
    request(input: SkillHttpRequest): Promise<SkillHttpResponse>;
  };
}

export async function testSkill(skill: SkillDefinition, capabilityName: string, input: unknown, options: TestSkillOptions = {}): Promise<unknown> {
  const capability = skill.capabilities[capabilityName];
  if (!capability) {
    throw new Error(`Unknown capability: ${capabilityName}`);
  }
  const parsedInput = capability.input.parse(input);
  const files = new Map(Object.entries(options.files ?? {}));
  const result = await capability.handler(parsedInput, {
    runId: "test_run",
    stepId: "test_step",
    skillId: skill.id,
    capability: capabilityName,
    signal: new AbortController().signal,
    events: { emit() {} },
    artifacts: {
      async write(artifactInput) {
        const content = typeof artifactInput.content === "string" ? artifactInput.content : artifactInput.content.toString("utf8");
        const artifact: ArtifactRecord = {
          id: `test_artifact_${crypto.randomUUID()}`,
          runId: "test_run",
          stepId: "test_step",
          type: artifactInput.type,
          name: artifactInput.name,
          path: `memory://artifacts/${artifactInput.name}`,
          mimeType: artifactInput.mimeType,
          sizeBytes: Buffer.byteLength(content),
          metadata: artifactInput.metadata ?? {},
          createdAt: new Date().toISOString()
        };
        files.set(artifact.path, content);
        return artifact;
      }
    },
    files: {
      async readText(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`Test file not found: ${path}`);
        return content;
      },
      async writeText(path, content) {
        files.set(path, content);
      }
    },
    memory: { async write() {} },
    secrets: { async get(name: string) { return Object.hasOwn(options.secrets ?? {}, name) ? options.secrets?.[name] : process.env[name]; } },
    http: {
      async request<TBody = unknown>(request: SkillHttpRequest): Promise<SkillHttpResponse<TBody>> {
        if (!options.http) {
          throw new Error(`Test HTTP request not mocked: ${request.method} ${request.url}`);
        }
        return options.http.request(request) as Promise<SkillHttpResponse<TBody>>;
      },
    },
    logger: { info() {}, warn() {}, error() {} }
  });
  return capability.output.parse(result);
}
