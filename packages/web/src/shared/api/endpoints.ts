export const endpoints = {
  conversations: "/v1/conversations",
  conversationById: (id: string) => `/v1/conversations/${id}`,
  conversationMessages: (id: string) => `/v1/conversations/${id}/messages`
};
