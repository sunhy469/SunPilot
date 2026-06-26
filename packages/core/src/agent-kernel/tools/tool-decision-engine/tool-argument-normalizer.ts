import type { AgentContext } from "../../loop-types.js";
import type { SkillSummary } from "../tool-types.js";

export function buildToolArgumentsHeuristic(
  context: AgentContext,
  skill?: SkillSummary,
): Record<string, unknown> {
  const message = context.currentMessage.content.trim();
  const attachments = context.currentMessage.attachments ?? [];
  const urls = extractUrls(message);

  const imageAttachment =
    attachments.find(
      (attachment) =>
        Boolean(attachment.url) &&
        (attachment.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(
            attachment.url ?? "",
          )),
    ) ??
    attachments.find(
      (attachment) =>
        Boolean(attachment.dataUrl) &&
        (attachment.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(
            attachment.name ?? "",
          )),
    );

  const imageUrl =
    imageAttachment?.url ??
    urls.find((url) => /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(url)) ??
    urls[0];

  const isSearchLike =
    skill &&
    /search|source|lookup|find|1688|搜索|货源|同款/i.test(
      `${skill.id} ${skill.name} ${skill.description}`,
    );

  const args: Record<string, unknown> = {};
  if (isSearchLike && message.length > 0) {
    args.query = message;
  }
  if (attachments.length > 0) {
    args.attachments = attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      url: attachment.url,
      dataUrl: attachment.dataUrl,
      storageKey: attachment.storageKey,
      provider: attachment.provider,
    }));
  }
  if (imageAttachment) {
    fillImageArguments(args, imageAttachment);
  } else if (imageUrl) {
    args.imageUrl = imageUrl;
    args.image_url = imageUrl;
  }
  if (urls.length > 0) {
    args.urls = urls;
    args.url = urls[0];
  }
  if (!args.url && imageUrl) {
    args.url = imageUrl;
  }

  return args;
}

export function canonicalizeArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };

  if (normalized.image_url !== undefined && normalized.imageUrl === undefined) {
    normalized.imageUrl = normalized.image_url;
  }
  if (
    normalized.image_data_url !== undefined &&
    normalized.imageDataUrl === undefined
  ) {
    normalized.imageDataUrl = normalized.image_data_url;
  }

  return normalized;
}

function extractUrls(text: string): string[] {
  return Array.from(
    text.matchAll(/https?:\/\/[^\s)）"'<>]+/gi),
    (match) => match[0],
  );
}

function fillImageArguments(
  args: Record<string, unknown>,
  image: { url?: string; dataUrl?: string },
): void {
  if (image.url) {
    args.imageUrl = image.url;
    args.image_url = image.url;
    if (!args.url) args.url = image.url;
  }
  if (image.dataUrl) {
    args.imageDataUrl = image.dataUrl;
    args.image_data_url = image.dataUrl;
  }
}
