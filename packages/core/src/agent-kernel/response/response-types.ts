import type { AgentEventBus } from '../agent-event-bus.js';
import type { ChatMessage } from '../../llm/llm.types.js';
import type { ModelCallRepository } from '@sunpilot/storage';

export interface ResponseComposerDeps {
  /** LLM provider for generating responses. */
  llm: {
    id?: string;
    model?: string;
    streamChat(request: {
      messages: ChatMessage[];
    }): AsyncIterable<{ delta: string }>;
  };
  /** Event bus for streaming delta events. */
  eventBus: AgentEventBus;
  /** Save the final assistant message with optional metadata for provenance. */
  saveMessage: (input: {
    id: string;
    conversationId: string;
    role: 'assistant';
    content: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  /** Durable audit/cost log for LLM invocations. */
  modelCalls?: ModelCallRepository;
}

export interface ComposeResult {
  messageId: string;
  content: string;
}
