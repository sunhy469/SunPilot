import type {
  AgentContext,
  AgentObservation,
  AgentPlan,
  AgentReflection,
  ReflectionEngine,
  RoutedIntent,
} from "../loop-types.js";

/**
 * Evaluates tool observations before response composition.
 */
export class BasicReflectionEngine implements ReflectionEngine {
  async reflect(
    input: {
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      observation: AgentObservation;
    },
    signal: AbortSignal,
  ): Promise<AgentReflection> {
    if (signal.aborted) throw new Error("Reflection aborted");

    const failed = input.observation.toolCalls.filter(
      (call) => call.status !== "completed",
    );
    if (failed.length > 0) {
      return {
        goalAchieved: false,
        summary: `Tool execution had ${failed.length} non-completed call(s): ${failed
          .map((call) => `${call.name}: ${call.status}`)
          .join(", ")}`,
        nextAction: "respond",
      };
    }

    const plannedSteps = input.plan?.steps.length ?? 0;
    const completedTools = input.observation.toolCalls.length;
    return {
      goalAchieved: true,
      summary:
        completedTools > 0
          ? `Completed ${completedTools} tool call(s) across ${plannedSteps} planned step(s).`
          : "No tool calls were required after reflection.",
      nextAction: "respond",
    };
  }
}
