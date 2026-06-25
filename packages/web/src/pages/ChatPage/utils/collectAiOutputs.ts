import type { ChatMessage } from "../../../features/conversations/types";
import type {
  RichCardView,
  ImageCardData,
  VideoCardData,
  AudioCardData,
  FileBundleCardData,
  PdfPreviewCardData,
  GalleryCardData,
} from "../../../rich-cards/types";

export interface AiOutputItem {
  id: string;
  messageId: string;
  type: "image" | "video" | "audio" | "file" | "pdf" | "gallery";
  title: string;
  url?: string;
  mimeType?: string;
  createdAt: string;
  cardId?: string;
  artifactId?: string;
}

function extractRichTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text: string }).text);
  }
  return "";
}

function cardToOutputs(
  message: ChatMessage,
  card: RichCardView,
): AiOutputItem[] {
  const outputs: AiOutputItem[] = [];
  const baseId = `${message.id}:${card.id}`;
  const createdAt = message.createdAt;
  const messageId = message.id;
  const cardId = card.id;

  if (card.type === "image") {
    const data = card.data as ImageCardData;
    outputs.push({
      id: baseId,
      messageId,
      cardId,
      type: "image",
      title:
        extractRichTextValue(card.title) ||
        data.caption ||
        "图片产物",
      url: data.src,
      createdAt,
    });
  }

  if (card.type === "video") {
    const data = card.data as VideoCardData;
    outputs.push({
      id: baseId,
      messageId,
      cardId,
      type: "video",
      title:
        extractRichTextValue(card.title) ||
        data.caption ||
        "视频产物",
      url: data.src,
      createdAt,
    });
  }

  if (card.type === "audio") {
    const data = card.data as AudioCardData;
    outputs.push({
      id: baseId,
      messageId,
      cardId,
      type: "audio",
      title:
        extractRichTextValue(card.title) ||
        extractRichTextValue(data.title) ||
        "音频产物",
      url: data.src,
      createdAt,
    });
  }

  if (card.type === "file") {
    const data = card.data as { fileName?: string; href?: string; name?: string; url?: string };
    outputs.push({
      id: baseId,
      messageId,
      cardId,
      type: "file",
      title:
        data.fileName ||
        data.name ||
        extractRichTextValue(card.title) ||
        "文件产物",
      url: data.href || data.url,
      createdAt,
    });
  }

  if (card.type === "file_bundle") {
    const data = card.data as FileBundleCardData;
    for (let i = 0; i < data.files.length; i++) {
      const file = data.files[i];
      if (!file) continue;
      outputs.push({
        id: `${baseId}:${i}`,
        messageId,
        cardId,
        type: "file",
        title: file.name || `文件 ${i + 1}`,
        url: file.href,
        mimeType: file.type,
        createdAt,
      });
    }
  }

  if (card.type === "pdf_preview") {
    const data = card.data as PdfPreviewCardData;
    outputs.push({
      id: baseId,
      messageId,
      cardId,
      type: "pdf",
      title:
        extractRichTextValue(card.title) ||
        extractRichTextValue(data.title) ||
        "PDF 产物",
      url: data.src,
      createdAt,
    });
  }

  if (card.type === "gallery") {
    const data = card.data as GalleryCardData;
    for (let i = 0; i < data.images.length; i++) {
      const img = data.images[i];
      if (!img) continue;
      outputs.push({
        id: `${baseId}:${i}`,
        messageId,
        cardId,
        type: "image",
        title: img.alt || img.caption || `图片 ${i + 1}`,
        url: img.src,
        createdAt,
      });
    }
  }

  return outputs;
}

export function collectAiOutputs(messages: ChatMessage[]): AiOutputItem[] {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => {
      const cards = message.cards ?? [];
      return cards.flatMap((card) => cardToOutputs(message, card));
    });
}
