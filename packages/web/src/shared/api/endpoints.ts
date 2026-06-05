export const endpoints = {
  conversations: "/v1/conversations",
  conversationMessages: (id: string) => `/v1/conversations/${id}/messages`
};
