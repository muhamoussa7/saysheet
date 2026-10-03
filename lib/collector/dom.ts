import type {
  CommentRecord,
  PostMetadata,
  PostTarget,
} from '../types';

export type PostRoot = Document | HTMLElement;

export interface ExpandAction {
  element: HTMLElement;
  kind: 'text' | 'replies' | 'comments';
  label: string;
  key: string;
}

const MIN_SCROLL_RANGE = 48;
const COMMENT_SORTS = ['Most relevant', 'All comments', 'Newest'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

const COMMENT_ARTICLE_SELECTOR =
  '[role="article"][aria-label^="Comment by "], [role="article"][aria-label^="Reply by "]';

const CONTROL_LABELS = [
  /^Hide or report/i,
  /^Like$/i,
  /^React$/i,
  /^Reply$/i,
  /^Share$/i,
  /^Follow$/i,
  /^See who reacted/i,
  /reactions?; see who reacted/i,
  /^Edited$/i,
];

function cleanText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function elementLabel(element: Element): string {
  return cleanText(element.getAttribute('aria-label') || element.textContent);
}

function sortName(element: Element | undefined): CommentSort | undefined {
  if (!element) return undefined;
  const label = elementLabel(element).toLocaleLowerCase();
  return COMMENT_SORTS.find((sort) => label.startsWith(sort.toLocaleLowerCase()));
}

function isHidden(element: Element): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const html = element as HTMLElement;
  return html.hidden || html.style.display === 'none' || html.style.visibility === 'hidden';
}

function isCommentArticle(element: Element): element is HTMLElement {
  if (element.getAttribute('role') !== 'article') return false;
  const label = element.getAttribute('aria-label') ?? '';
  return /^(Comment|Reply) by /i.test(label);
}

function articlesWithin(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(COMMENT_ARTICLE_SELECTOR)].filter(
    (article) => !isHidden(article),
  );
}

function canonicalPath(target: PostTarget): string {
  try {
    return new URL(target.canonicalUrl).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function rootScore(root: HTMLElement, target: PostTarget): number {
  const articleCount = articlesWithin(root).length;
  const targetPath = canonicalPath(target);
  const matchingLinks = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
    (anchor) => {
      try {
        const href = new URL(anchor.href, target.canonicalUrl);
        return Boolean(targetPath) && href.pathname.replace(/\/$/, '') === targetPath;
      } catch {
        return false;
      }
    },
  ).length;
  const sortControl = [...root.querySelectorAll('[role="button"], button')].some((node) =>
    /^(Most relevant|All comments|Newest)$/i.test(elementLabel(node)),
  );
  return articleCount * 10 + matchingLinks * 5 + (sortControl ? 3 : 0);
}

export function findPostRoot(
  documentRef: Document,
  target: PostTarget,
): PostRoot | null {
  const dialogs = [...documentRef.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const scoredDialogs = dialogs
    .map((dialog) => ({ dialog, score: rootScore(dialog, target) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (scoredDialogs[0]) return scoredDialogs[0].dialog;

  const targetPath = canonicalPath(target);
  const matchingAnchors = [...documentRef.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
    (anchor) => {
      try {
        const href = new URL(anchor.href, target.canonicalUrl);
        return Boolean(targetPath) && href.pathname.replace(/\/$/, '') === targetPath;
      } catch {
        return false;
      }
    },
  );

  for (const anchor of matchingAnchors) {
    let parent = anchor.parentElement;
    for (let depth = 0; parent && depth < 14; depth += 1, parent = parent.parentElement) {
      if (articlesWithin(parent).length > 0) return parent;
    }
  }

  const allArticles = articlesWithin(documentRef);
  if (allArticles.length > 0) {
    return allArticles[0]?.closest<HTMLElement>('main') ?? documentRef;
  }

  return dialogs.at(-1) ?? documentRef.querySelector<HTMLElement>('main');
}

/**
 * Finds Facebook's inner comments viewport. Post dialogs scroll inside a nested
 * div, so scrolling the window (or merely looking for a "more" button) is not
 * enough to make Facebook render the remaining comments.
 */
export function findCommentScroller(root: PostRoot): HTMLElement | undefined {
  const candidates = new Set<HTMLElement>();
  const rootElement = root instanceof Document ? root.documentElement : root;
  const articles = articlesWithin(root);
  const representatives = [articles[0], articles[Math.floor(articles.length / 2)], articles.at(-1)]
    .filter((article): article is HTMLElement => Boolean(article));

  for (const article of representatives) {
    let current = article.parentElement;
    while (current) {
      candidates.add(current);
      if (current === rootElement) break;
      current = current.parentElement;
    }
  }

  candidates.add(rootElement);
  if (root instanceof Document && root.scrollingElement?.tagName) {
    candidates.add(root.scrollingElement as HTMLElement);
  }

  return [...candidates]
    .map((element) => {
      const range = element.scrollHeight - element.clientHeight;
      const overflowY = element.ownerDocument.defaultView
        ?.getComputedStyle(element).overflowY ?? '';
      const articleCount = element.querySelectorAll(COMMENT_ARTICLE_SELECTOR).length;
      const scrollStyle = /^(auto|scroll|overlay)$/i.test(overflowY) ? 1 : 0;
      return {
        element,
        range,
        score: scrollStyle * 1_000_000_000 + articleCount * 1_000_000 + range,
      };
    })
    .filter(({ element, range }) => element.clientHeight > 0 && range > MIN_SCROLL_RANGE)
    .sort((a, b) => b.score - a.score)[0]?.element;
}

function sanitizedAbsoluteUrl(raw: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('__') || ['fbclid', 'ref', 'refid'].includes(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseMetricCount(raw: string): number | undefined {
  const normalized = raw.replace(/,/g, '').trim().toUpperCase();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([KMB])?/);
  if (!match?.[1]) return undefined;
  const base = Number.parseFloat(match[1]);
  const multiplier = match[2] === 'K' ? 1_000 : match[2] === 'M' ? 1_000_000 : match[2] === 'B' ? 1_000_000_000 : 1;
  return Number.isFinite(base) ? Math.round(base * multiplier) : undefined;
}

function commentIdentityFromUrl(
  rawUrl: string | undefined,
  baseUrl: string,
): { id?: string; parentId?: string; url?: string } {
  if (!rawUrl) return {};
  const urlString = sanitizedAbsoluteUrl(rawUrl, baseUrl);
  if (!urlString) return {};
  try {
    const url = new URL(urlString);
    const commentId = url.searchParams.get('comment_id') ?? undefined;
    const replyId = url.searchParams.get('reply_comment_id') ?? undefined;
    return {
      id: replyId ?? commentId,
      parentId: replyId ? commentId : undefined,
      url: urlString,
    };
  } catch {
    return {};
  }
}

function findPermalink(article: HTMLElement): HTMLAnchorElement | undefined {
  return [...article.querySelectorAll<HTMLAnchorElement>('a[href]')].find((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    return href.includes('comment_id=') || href.includes('reply_comment_id=');
  });
}

function looksLikeProfileUrl(raw: string, baseUrl: string): boolean {
  try {
    const url = new URL(raw, baseUrl);
    if (!url.hostname.endsWith('facebook.com')) return false;
    return (
      /\/user\/[^/]+/i.test(url.pathname) ||
      /\/profile\.php/i.test(url.pathname) ||
      (/^\/[^/]+\/?$/.test(url.pathname) && !['/photo/', '/watch/', '/reel/'].includes(url.pathname))
    );
  } catch {
    return false;
  }
}

function findAuthor(
  article: HTMLElement,
  target: PostTarget,
): { name: string; profileUrl?: string; element?: Element } {
  const links = [...article.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
    (link) =>
      link.closest(COMMENT_ARTICLE_SELECTOR) === article &&
      looksLikeProfileUrl(link.getAttribute('href') ?? '', target.canonicalUrl),
  );
  const namedLink = links.find((link) => cleanText(link.textContent).length > 0);
  if (namedLink) {
    return {
      name: cleanText(namedLink.textContent),
      profileUrl: sanitizedAbsoluteUrl(
        namedLink.getAttribute('href') ?? namedLink.href,
        target.canonicalUrl,
      ),
      element: namedLink,
    };
  }

  const anonymous = [...article.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (button) => /^Anonymous participant/i.test(elementLabel(button)),
  );
  if (anonymous) return { name: elementLabel(anonymous), element: anonymous };

  const articleLabel = article.getAttribute('aria-label') ?? '';
  const fallback = articleLabel.match(/^(?:Comment|Reply) by (.+?)(?:\s+(?:a|an|\d+)\s+(?:second|minute|hour|day|week|month|year)s? ago|\s+just now|$)/i);
  return { name: cleanText(fallback?.[1]) || 'Unknown author' };
}

function findActionBoundary(article: HTMLElement): Element | undefined {
  return [...article.querySelectorAll('button, [role="button"]')].find((button) => {
    const label = elementLabel(button);
    return CONTROL_LABELS.some((pattern) => pattern.test(label));
  });
}

function textNodeIsInsideCurrentArticle(node: Text, article: HTMLElement): boolean {
  const parent = node.parentElement;
  if (!parent || isHidden(parent)) return false;
  return parent.closest(COMMENT_ARTICLE_SELECTOR) === article;
}

function textNodeIsAfter(node: Text, element: Element): boolean {
  const relation = element.compareDocumentPosition(node);
  return Boolean(relation & 4) && !element.contains(node);
}

function textNodeIsBefore(node: Text, element: Element): boolean {
  const relation = element.compareDocumentPosition(node);
  return Boolean(relation & 2) && !element.contains(node);
}

function extractCommentText(
  article: HTMLElement,
  authorElement: Element | undefined,
  permalink: Element | undefined,
): string {
  const boundary = findActionBoundary(article);
  const start = permalink ?? authorElement;
  const walker = article.ownerDocument.createTreeWalker(article, 4);
  const lines: Array<{ container: Element; parts: string[] }> = [];
  let node = walker.nextNode();

  while (node) {
    const textNode = node as Text;
    const text = cleanText(textNode.nodeValue);
    const parent = textNode.parentElement;
    const interactive = parent?.closest('button, [role="button"], a[href]');

    const validPosition =
      (!start || textNodeIsAfter(textNode, start)) &&
      (!boundary || textNodeIsBefore(textNode, boundary));
    const belongsToContentLink =
      interactive instanceof HTMLAnchorElement &&
      interactive !== permalink &&
      interactive !== authorElement;

    if (
      text &&
      text !== '·' &&
      text.toLowerCase() !== 'edited' &&
      validPosition &&
      textNodeIsInsideCurrentArticle(textNode, article) &&
      (!interactive || belongsToContentLink)
    ) {
      let container: Element = parent ?? article;
      while (
        container.parentElement &&
        container.parentElement !== article &&
        !['DIV', 'P', 'LI', 'BLOCKQUOTE'].includes(container.tagName)
      ) {
        container = container.parentElement;
      }
      const previous = lines.at(-1);
      if (previous?.container === container) {
        if (previous.parts.at(-1) !== text) previous.parts.push(text);
      } else {
        lines.push({ container, parts: [text] });
      }
    }
    node = walker.nextNode();
  }

  return lines
    .map((line) => line.parts.join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findReactionCount(article: HTMLElement): number | undefined {
  const control = [...article.querySelectorAll('button, [role="button"]')].find((node) =>
    /reactions?; see who reacted/i.test(elementLabel(node)),
  );
  return control ? parseMetricCount(elementLabel(control)) : undefined;
}

function findDisplayedReplyCount(article: HTMLElement): number | undefined {
  const descendants = [...article.querySelectorAll('button, [role="button"]')];
  const siblings: Element[] = [];
  let sibling = article.nextElementSibling;
  for (let i = 0; sibling && i < 3; i += 1, sibling = sibling.nextElementSibling) {
    if (isCommentArticle(sibling)) break;
    siblings.push(sibling);
  }
  const siblingControls = siblings.flatMap((item) => [
    ...(item.matches('button, [role="button"]') ? [item] : []),
    ...item.querySelectorAll('button, [role="button"]'),
  ]);
  const candidate = [...descendants, ...siblingControls]
    .find((node) => /^(?:View|See)\s+(\d+)\s+(?:more\s+)?repl(?:y|ies)$/i.test(elementLabel(node)));
  return candidate ? parseMetricCount(elementLabel(candidate)) : undefined;
}

function collectAttachments(
  article: HTMLElement,
  authorElement: Element | undefined,
  permalink: Element | undefined,
  target: PostTarget,
): { types: CommentRecord['attachmentTypes']; urls: string[] } {
  const types = new Set<CommentRecord['attachmentTypes'][number]>();
  const urls = new Set<string>();

  for (const anchor of article.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (anchor.closest(COMMENT_ARTICLE_SELECTOR) !== article) continue;
    if (anchor === authorElement || anchor === permalink || authorElement?.contains(anchor)) continue;
    if (looksLikeProfileUrl(anchor.getAttribute('href') ?? '', target.canonicalUrl)) continue;
    const href = sanitizedAbsoluteUrl(
      anchor.getAttribute('href') ?? anchor.href,
      target.canonicalUrl,
    );
    if (!href) continue;
    if (/facebook\.com\/(?:photo|photos)/i.test(href) || /fbcdn\.net/i.test(href)) {
      types.add('photo');
      urls.add(href);
    } else if (/facebook\.com\/(?:watch|reel|videos)/i.test(href)) {
      types.add('video');
      urls.add(href);
    } else if (!href.includes('comment_id=')) {
      types.add('link');
      urls.add(href);
    }
  }

  for (const media of article.querySelectorAll<HTMLElement>(
    'img[src], video[src], video source[src]',
  )) {
    if (media.closest(COMMENT_ARTICLE_SELECTOR) !== article) continue;
    if (authorElement?.contains(media)) continue;
    const mediaAnchor = media.closest<HTMLAnchorElement>('a[href]');
    if (
      mediaAnchor &&
      looksLikeProfileUrl(mediaAnchor.getAttribute('href') ?? '', target.canonicalUrl)
    ) {
      continue;
    }
    const mediaControl = media.closest('button, [role="button"]');
    if (
      mediaControl &&
      (CONTROL_LABELS.some((pattern) => pattern.test(elementLabel(mediaControl))) ||
        /avatar|profile picture|reaction icon|emoji/i.test(elementLabel(mediaControl)))
    ) {
      continue;
    }
    const raw = media.getAttribute('src');
    const url = raw ? sanitizedAbsoluteUrl(raw, target.canonicalUrl) : undefined;
    if (!url) continue;
    if (media.tagName === 'VIDEO' || media.closest('video')) types.add('video');
    else types.add('photo');
    urls.add(url);
  }

  return { types: [...types], urls: [...urls] };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function commentFingerprint(comment: CommentRecord): string {
  return stableHash(
    JSON.stringify([
      comment.parentId,
      comment.authorName,
      comment.authorProfileUrl,
      comment.text,
      comment.publishedAtDisplay,
      comment.reactionCount,
      comment.attachmentUrls,
    ]),
  );
}

function parseComment(
  article: HTMLElement,
  target: PostTarget,
  sequence: number,
): CommentRecord {
  const warnings: string[] = [];
  const permalink = findPermalink(article);
  const identity = commentIdentityFromUrl(
    permalink?.getAttribute('href') ?? permalink?.href,
    target.canonicalUrl,
  );
  const author = findAuthor(article, target);
  const text = extractCommentText(article, author.element, permalink);
  const timestampDisplay = cleanText(
    permalink?.getAttribute('aria-label') || permalink?.getAttribute('title'),
  );
  // Chrome can't parse Facebook's "Friday, August 21, 2026 at 11:34 AM" until " at " is removed.
  const parsedTimestamp = timestampDisplay
    ? Date.parse(timestampDisplay.replace(/\s+at\s+/i, ' '))
    : Number.NaN;
  const attachments = collectAttachments(article, author.element, permalink, target);

  if (!identity.id) warnings.push('Facebook did not expose a comment ID; a fallback ID was used.');
  if (!text) warnings.push('No comment text was detected; this may be an attachment-only comment.');
  if (!timestampDisplay) warnings.push('No exact timestamp was exposed.');

  const fallbackId = `fallback-${stableHash(
    [target.canonicalUrl, author.name, timestampDisplay, text, attachments.urls.join('|')].join('::'),
  )}`;
  const id = identity.id ?? fallbackId;
  const parentArticle = article.parentElement?.closest<HTMLElement>(COMMENT_ARTICLE_SELECTOR);
  const parentPermalink = parentArticle ? findPermalink(parentArticle) : undefined;
  const parentIdentity = commentIdentityFromUrl(
    parentPermalink?.getAttribute('href') ?? parentPermalink?.href,
    target.canonicalUrl,
  );
  const parentId = identity.parentId ?? parentIdentity.id;

  return {
    id,
    parentId,
    depth: parentId ? 1 : 0,
    type: parentId ? 'reply' : 'comment',
    sequence,
    authorName: author.name,
    authorProfileUrl: author.profileUrl,
    text,
    publishedAtDisplay: timestampDisplay || undefined,
    publishedAtIso: Number.isNaN(parsedTimestamp)
      ? undefined
      : new Date(parsedTimestamp).toISOString(),
    edited: [...article.querySelectorAll('[aria-label], span, div')].some(
      (node) => elementLabel(node) === 'Edited',
    ),
    reactionCount: findReactionCount(article),
    replyCountDisplayed: findDisplayedReplyCount(article),
    commentUrl: identity.url,
    attachmentTypes: attachments.types,
    attachmentUrls: attachments.urls,
    postType: target.type,
    parseWarnings: warnings,
  };
}

export function extractComments(root: PostRoot, target: PostTarget): CommentRecord[] {
  return articlesWithin(root).map((article, index) => parseComment(article, target, index + 1));
}

function firstNumericLabel(root: ParentNode, matcher: RegExp): number | undefined {
  for (const element of root.querySelectorAll('[aria-label], button, [role="button"]')) {
    const label = cleanText(
      `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`,
    );
    if (!matcher.test(label)) continue;
    const count = parseMetricCount(label);
    if (count !== undefined) return count;
  }
  return undefined;
}

export function extractPostMetadata(root: PostRoot): PostMetadata {
  const documentRef = root instanceof Document ? root : root.ownerDocument;
  const postHeadingLink = [...root.querySelectorAll<HTMLAnchorElement>('h1 a, h2 a, h3 a, h4 a')].find(
    (link) => !link.closest(COMMENT_ARTICLE_SELECTOR) && cleanText(link.textContent),
  );

  return {
    pageTitle: documentRef.title,
    postAuthor: postHeadingLink ? cleanText(postHeadingLink.textContent) : undefined,
    containerName: documentRef.title || undefined,
    displayedCommentCount: firstNumericLabel(root, /Leave a comment|comments?/i),
    currentSort: getCurrentSort(root),
    interfaceLanguage: documentRef.documentElement.lang || 'unknown',
    documentDirection: documentRef.documentElement.dir || 'ltr',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
  };
}

function closestCommentId(control: HTMLElement, target: PostTarget): string {
  const article = control.closest<HTMLElement>(COMMENT_ARTICLE_SELECTOR);
  if (!article) return 'post';
  const permalink = findPermalink(article);
  return commentIdentityFromUrl(
    permalink?.getAttribute('href') ?? permalink?.href,
    target.canonicalUrl,
  ).id ?? 'unknown';
}

export function findExpandActions(root: PostRoot, target: PostTarget): ExpandAction[] {
  const actions: ExpandAction[] = [];
  const controls = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')];
  const counters = new Map<string, number>();

  for (const control of controls) {
    if (isHidden(control) || control.getAttribute('aria-disabled') === 'true' || control.hasAttribute('disabled')) {
      continue;
    }
    const label = elementLabel(control);
    let kind: ExpandAction['kind'] | undefined;

    if (label === 'See more' && control.closest(COMMENT_ARTICLE_SELECTOR)) kind = 'text';
    else if (
      /^(?:View|See)\s+(?:(?:\d+|more|previous)\s+)?(?:more\s+|previous\s+)?repl(?:y|ies)$/i.test(label) ||
      /^\d+\s+(?:more\s+)?repl(?:y|ies)$/i.test(label)
    ) {
      kind = 'replies';
    } else if (/^(?:(?:View|See|Load)\s+)?(?:(?:\d+)\s+)?(?:more|previous)\s+comments?$/i.test(label)) {
      kind = 'comments';
    }

    if (!kind) continue;
    const context = closestCommentId(control, target);
    const signature = `${kind}:${context}:${label}`;
    const occurrence = (counters.get(signature) ?? 0) + 1;
    counters.set(signature, occurrence);
    actions.push({
      element: control,
      kind,
      label,
      key: `${signature}:${occurrence}`,
    });
  }

  const priority: Record<ExpandAction['kind'], number> = { text: 0, comments: 1, replies: 2 };
  return actions.sort((a, b) => priority[a.kind] - priority[b.kind]);
}

export function findCurrentSort(root: PostRoot): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].find((node) =>
    !isHidden(node) && Boolean(sortName(node)),
  );
}

export function getCurrentSort(root: PostRoot): CommentSort | undefined {
  return sortName(findCurrentSort(root));
}

export function findAllCommentsOption(documentRef: Document): HTMLElement | undefined {
  const menuOptions = [...documentRef.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="menuitemradio"], [role="radio"], [role="option"]',
  )];
  const fallbackButtons = [...documentRef.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .filter((node) => node.getAttribute('aria-haspopup') !== 'menu');
  return [...menuOptions, ...fallbackButtons].find(
    (node) => !isHidden(node) && sortName(node) === 'All comments',
  );
}

export function detectBlockingState(documentRef: Document): string | undefined {
  if (documentRef.querySelector('iframe[title*="captcha" i], input[name*="captcha" i]')) {
    return 'Facebook is showing a CAPTCHA.';
  }
  const dialogs = [...documentRef.querySelectorAll<HTMLElement>('[role="dialog"]')];
  for (const dialog of dialogs) {
    const text = cleanText(dialog.textContent).slice(0, 1_000);
    if (/temporarily blocked|security check|confirm your identity|session has expired/i.test(text)) {
      return 'Facebook requires an account or security check.';
    }
  }
  return undefined;
}
