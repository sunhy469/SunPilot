export type ChatViewState =
  | "welcome"
  | "loadingConversation"
  | "ready"
  | "streaming"
  | "offline"
  | "error";

/**
 * Local send state — tracks the lifecycle of a user message from composition
 * through upload, transmission, acknowledgment, and completion.
 *
 * Architecture doc §12.5: all user actions must show instant UI feedback.
 */
export type LocalSendState =
  | "editing"
  | "uploading"
  | "queued_until_upload_done"
  | "sending"
  | "accepted"
  | "running"
  | "streaming"
  | "completed"
  | "failed";
