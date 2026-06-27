import type {
  AgentContext,
  AgentLoopInput,
  ContextBuilder as ContextBuilderInterface,
} from "../loop-types.js";
import { ContextAssemblyPipeline } from "./context-builder/context-assembly-pipeline.js";
import type { ContextBuilderDeps } from "./context-builder/types.js";

export type {
  ContextBuilderDeps,
  MemoryRetrievalMetrics,
} from "./context-builder/types.js";

/** Stable public entry point for the context assembly pipeline. */
export class ContextBuilder implements ContextBuilderInterface {
  private readonly pipeline: ContextAssemblyPipeline;

  constructor(deps: ContextBuilderDeps) {
    this.pipeline = new ContextAssemblyPipeline(deps);
  }

  build(input: AgentLoopInput, signal: AbortSignal): Promise<AgentContext> {
    return this.pipeline.build(input, signal);
  }
}
