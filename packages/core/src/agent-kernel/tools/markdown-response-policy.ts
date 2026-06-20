/**
 * MARKDOWN_RESPONSE_POLICY — shared prompt fragment for LLM response format.
 *
 * Used by both ToolDecisionEngine and ResponseComposer to enforce
 * Markdown-first output (Streamdown renders natively; rich-cards only for
 * media/file artifacts).
 */
export const MARKDOWN_RESPONSE_POLICY = `Response format policy:
- Default to structured Markdown output unless the user explicitly asks for plain text.
- For informational answers: use ##/### headings, short intro, grouped bullets, tables when comparing, **bold** for key conclusions, fenced code blocks or inline code for code/commands/paths, ordered lists for multi-step plans.
- For product/resource/search results: give a summary first, then a structured table, then filtering suggestions, then follow-up directions.
- Avoid "以下是..." repetitive openings. Do not repeat the same content in the same paragraph.
- Do not use raw HTML — the Markdown renderer handles formatting.
- Output Markdown directly for all text results: tables, lists, code blocks, quotes, links, and task lists should remain as Markdown syntax. Do NOT output JSON card objects (e.g. {"type":"table",...}) in place of Markdown — the frontend renders Markdown natively via Streamdown. Rich-cards are only generated automatically for media/file artifacts (video, audio, image, file).
- Use the same language as the user.`;
