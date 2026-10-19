import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useEffect, useRef, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram';

interface OutlineItem {
  level: number;
  title: string;
  anchor: string;
}

interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: MarkdownNode[];
  properties?: Record<string, unknown>;
  position?: { start: { line: number; offset?: number }; end: { offset?: number } };
}

const components: Components = {
  pre({ children, node, ...props }) {
    const code = node?.children[0];
    if (node?.children.length === 1 && code?.type === 'element' && code.tagName === 'code'
      && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
      const source = code.children.filter((child) => child.type === 'text').map((child) => child.value).join('').replace(/\n$/, '');
      return <MermaidDiagram source={source} />;
    }
    return <pre {...props}>{children}</pre>;
  },
  img({ node: _node, src, ...props }) {
    return <img {...props} src={src || undefined} />;
  },
  table({ children, node: _node, ...props }) {
    return <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label={t("表格")}><table {...props}>{children}</table></div>;
  },
};

export function MarkdownDocument({ content, outline = [] }: { content: string; outline?: OutlineItem[] }) {
  useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const restoredLocation = useRef<string | null>(null);
  useEffect(() => {
    // Run after parent effects that reset a newly selected document to the top.
    const frame = window.requestAnimationFrame(() => {
      const fragment = window.location.hash;
      const location = `${window.location.pathname}${window.location.search}${fragment}`;
      if (restoredLocation.current === location) return;
      if (restoreMarkdownFragment(containerRef.current, fragment)) restoredLocation.current = location;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [content]);

  return <div ref={containerRef} className="markdown-document" onClick={handleMarkdownAnchorClick}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[headingAnchors(content, outline)]} remarkRehypeOptions={{ footnoteLabel: t('脚注'), footnoteBackLabel: t('返回正文') }} components={components}>{content}</ReactMarkdown>
  </div>;
}

function headingAnchors(content: string, outline: OutlineItem[]) {
  return () => (tree: MarkdownNode) => {
    const headings: MarkdownNode[] = [];
    const usedIds = new Set<string>();
    function visit(node: MarkdownNode) {
      const id = node.properties?.id;
      if (typeof id === 'string') usedIds.add(id);
      // Generated footnote headings already have an id and must keep it.
      if (node.tagName && /^h[1-6]$/.test(node.tagName) && !id) headings.push(node);
      node.children?.forEach(visit);
    }
    visit(tree);

    const lines = content.split(/\r?\n/);
    // The existing API outline includes every H1–H4 source line, including code.
    // When it has that shape, use source locations rather than a heading counter.
    const legacy = lines.flatMap((line, index) => {
      const match = /^(#{1,4})\s+(.+)$/.exec(line.trim());
      return match ? [{ line: index + 1, level: match[1].length, title: normalizeTitle(match[2]) }] : [];
    });
    const legacyOutline = outline.length === legacy.length && outline.every((item, index) => item.level === legacy[index].level && normalizeTitle(item.title) === legacy[index].title);
    const consumed = new Set<number>();
    const anchors = headings.map((heading) => {
      const level = Number(heading.tagName?.slice(1));
      const line = heading.position?.start.line;
      const sourceTitle = line ? /^(#{1,6})\s+(.+)$/.exec(lines[line - 1]?.trim() ?? '')?.[2] : undefined;
      const titles = new Set([normalizeTitle(nodeText(heading)), normalizeTitle(sourceTitle ?? '')]);
      const index = legacyOutline
        ? legacy.findIndex((item) => item.line === line && item.level === level)
        : outline.findIndex((item, index) => !consumed.has(index) && item.level === level && titles.has(normalizeTitle(item.title)));
      if (index >= 0) consumed.add(index);
      const explicit = index >= 0 ? outline[index]?.anchor : undefined;
      return explicit && !/[\s\p{Cc}]/u.test(explicit) && !/^[#/]/.test(explicit) ? explicit : undefined;
    });
    const reservedIds = new Set(anchors.filter((anchor): anchor is string => Boolean(anchor)));
    headings.forEach((heading, index) => {
      const explicit = anchors[index];
      const base = explicit ?? (nodeText(heading).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'heading');
      let id = base;
      let suffix = 2;
      while (usedIds.has(id) || (id !== explicit && reservedIds.has(id))) id = `${base}-${suffix++}`;
      usedIds.add(id);
      heading.properties = { ...heading.properties, id, tabIndex: -1 };
    });
  };
}

function normalizeTitle(title: string): string {
  return title.replace(/[*_`]/g, '').trim().replace(/\s+/g, ' ');
}

function nodeText(node: MarkdownNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.tagName === 'img') return String(node.properties?.alt ?? '');
  return node.children?.map(nodeText).join('') ?? '';
}

export function scrollToMarkdownAnchor(container: HTMLElement | null, anchor: string): boolean {
  if (!container || anchor.startsWith('#/')) return false;
  let id = anchor;
  if (anchor.startsWith('#')) {
    try { id = decodeURIComponent(anchor.slice(1)); } catch { return false; }
  }
  const target = id ? Array.from(container.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === id) : container;
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  return true;
}

export function restoreMarkdownFragment(container: HTMLElement | null, fragment: string): boolean {
  if (!container || !fragment.startsWith('#') || fragment === '#' || fragment.startsWith('#/')) return false;
  let id: string;
  try { id = decodeURIComponent(fragment.slice(1)); } catch { return false; }
  const firstTarget = container.ownerDocument.getElementById(id);
  // Several documents may share heading ids on the project home page. Match
  // native fragment navigation once, rather than letting every renderer scroll.
  if (!firstTarget || !container.contains(firstTarget)) return false;
  return scrollToMarkdownAnchor(container, fragment);
}

export function handleMarkdownAnchorClick(event: MouseEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!link || !event.currentTarget.contains(link)) return;
  const target = link.getAttribute('target');
  if (link.getAttribute('download') !== null || (target && target.toLowerCase() !== '_self')) return;
  const href = link.getAttribute('href');
  if (!href?.startsWith('#') || href.startsWith('#/')) return;
  if (!scrollToMarkdownAnchor(event.currentTarget, href)) return;
  event.preventDefault();
  if (typeof window !== 'undefined') {
    const fragment = new URL(href, window.location.href).hash;
    if (window.location.hash !== fragment) window.history.pushState(window.history.state, '', fragment || '#');
  }
}
