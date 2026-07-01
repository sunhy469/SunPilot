export const endpoints = {
  conversations: "/v1/conversations",
  conversationById: (id: string) => `/v1/conversations/${id}`,
  conversationMessages: (id: string) => `/v1/conversations/${id}/messages`,
  conversationActiveRun: (id: string) => `/v1/conversations/${id}/active-run`,

  digitalWorld: "/v1/digital-world",
  digitalBeings: "/v1/digital-beings",
  digitalBeingById: (id: string) => `/v1/digital-beings/${id}`,
  digitalBeingTasks: (id: string) => `/v1/digital-beings/${id}/tasks`,
  digitalBeingSleep: (id: string) => `/v1/digital-beings/${id}/sleep`,
  digitalBeingWake: (id: string) => `/v1/digital-beings/${id}/wake`,
  digitalBeingActions: (id: string) => `/v1/digital-beings/${id}/actions`,
  digitalBeingActionLogs: (id: string) => `/v1/digital-beings/${id}/action-logs`,
  digitalBeingArtifacts: (id: string) => `/v1/digital-beings/${id}/artifacts`,
  worldNodes: "/v1/world-nodes",
};
