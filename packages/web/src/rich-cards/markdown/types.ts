import type { TableCardData, RichCardView } from "../types";

export interface ExtractedImage {
  src: string;
  alt?: string;
  caption?: string;
}

export interface ExtractedChecklistItem {
  id: string;
  label: string;
  checked: boolean;
}

export interface ExtractedLinkPreview {
  url: string;
  title?: string;
}

export interface ExtractedCodeBlock {
  language?: string;
  code: string;
}

export interface ExtractedContent {
  tables: TableCardData[];
  images: ExtractedImage[];
  checklists: Array<{
    items: ExtractedChecklistItem[];
  }>;
  linkPreviews: ExtractedLinkPreview[];
  codeBlocks: ExtractedCodeBlock[];
  cardDslCards: RichCardView[];
  remainingMarkdown: string;
}
