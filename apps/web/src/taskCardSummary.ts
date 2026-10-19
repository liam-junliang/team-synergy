const MULTILINE_WHITESPACE = /\s+/g;
const BLOCK_MARKERS = /^\s{0,3}(#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/gm;
const FENCED_CODE_MARKERS = /```[\s\S]*?```/g;
const INLINE_LINK = /\[([^\]]+)\]\((?:[^)\s]+)\)/g;
const INLINE_IMAGE = /!\[([^\]]*)\]\((?:[^)\s]+)\)/g;
const INLINE_CODE = /`([^`]+)`/g;
const EMPHASIS = /(\*\*|__|\*|_)/g;
const HORIZONTAL_RULES = /^\s{0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/gm;

function stripHtmlLike(text: string): string {
  return text
    .replace(FENCED_CODE_MARKERS, ' ')
    .replace(HORIZONTAL_RULES, ' ')
    .replace(BLOCK_MARKERS, '')
    .replace(INLINE_IMAGE, '$1')
    .replace(INLINE_LINK, '$1')
    .replace(INLINE_CODE, '$1')
    .replace(EMPHASIS, '');
}

export function summarizeTaskBrief(brief?: string | null): string {
  if (!brief) return '';
  return stripHtmlLike(brief)
    .replace(MULTILINE_WHITESPACE, ' ')
    .trim();
}
