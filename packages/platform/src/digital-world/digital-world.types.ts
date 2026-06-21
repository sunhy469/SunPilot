export interface CreateBeingInput {
  name: string;
  description?: string;
  homeNodeId: string;
  conversationId?: string;
}

export interface UpdateBeingInput {
  name?: string;
  description?: string;
  status?: string;
  statusText?: string;
}

export interface CreateTaskInput {
  type: string;
  title: string;
  input?: Record<string, unknown>;
}

export interface WorldStateResult {
  nodes: import("@sunpilot/storage").WorldNodeRecord[];
  edges: import("@sunpilot/storage").WorldEdgeRecord[];
  beings: import("@sunpilot/storage").DigitalBeingRecord[];
}
