import type { CommentRecord, PostMetadata, PostTarget } from '../types';

export type LinkedInPostRoot = Document | HTMLElement;

export interface LinkedInExpandAction {
  element: HTMLElement;
  kind: 'text' | 'replies' | 'comments';
  label: string;
  key: string;
}

export type LinkedInCommentSort = 'Most relevant' | 'Most recent' | 'Verified';

const COMMENT_SELECTOR = '[id^="replaceableComment_urn:li:comment:"]';
const COMMENT_SORTS: LinkedInCommentSort[] = ['Most relevant', 'Most recent', 'Verified'];

function cleanText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function elementLabel(element: Element): string {
  return cleanText(element.getAttribute('aria-label') || element.textContent);
}

function isHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.getAttribute('aria-hidden') === 'true') return true;
    const html = current as HTMLElement;
    if (html.hidden || html.style.display === 'none' || html.style.visibility === 'hidden') return true;
    current = current.parentElement;
  }

  const view = element.ownerDocument.defaultView;
  if (view && !/jsdom/i.test(view.navigator.userAgent)) {
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    return element.getClientRects().length === 0;
  }
  return false;
}

function parseMetricCount(raw: string): number | undefined {
  const match = raw.replace(/,/g, '').trim().toUpperCase().match(/(\d+(?:\.\d+)?)\s*([KMB])?/);
  if (!match?.[1]) return undefined;
  const base = Number.parseFloat(match[1]);
  const multiplier = match[2] === 'K'
    ? 1_000
    : match[2] === 'M'
      ? 1_000_000
      : match[2] === 'B'
        ? 1_000_000_000
        : 1;
  return Number.isFinite(base) ? Math.round(base * multiplier) : undefined;
}

function sanitizedUrl(raw: string | undefined, baseUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:trk|trackingId|lipi|midToken|utm_)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function commentWrappers(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(COMMENT_SELECTOR)].filter(
    (element) => !isHidden(element),
  );
}

function hasLinkedInCommentSection(root: ParentNode): boolean {
  return Boolean(
    root.querySelector(
      `${COMMENT_SELECTOR}, [componentkey*="commentsSectionContainer"], ` +
      '[data-testid*="commentList"], [componentkey^="expanded"][id^="expanded"]',
    ),
  );
}

function commentIdentity(wrapper: HTMLElement): {
  activityUrn?: string;
  id?: string;
  urn?: string;
} {
  const source = `${wrapper.id} ${wrapper.getAttribute('componentkey') ?? ''}`;
  const match = source.match(/urn:li:comment:\((urn:li:(?:activity|share|ugcPost):[^,]+),(\d+)\)/i);
  if (!match?.[1] || !match[2]) return {};
  return {
    activityUrn: match[1],
    id: match[2],
    urn: `urn:li:comment:(${match[1]},${match[2]})`,
  };
}

function rootScore(root: HTMLElement, target: PostTarget): number {
  const wrappers = commentWrappers(root);
  const targetId = target.postId ?? '';
  const targetInComments = targetId
    ? wrappers.some((wrapper) => commentIdentity(wrapper).activityUrn?.endsWith(`:${targetId}`))
    : false;
  const targetInLink = targetId
    ? [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].some((anchor) =>
      (anchor.getAttribute('href') ?? '').includes(targetId))
    : false;
  const hasCommentSection = hasLinkedInCommentSection(root);
  return wrappers.length * 10 + (hasCommentSection ? 20 : 0) +
    (targetInComments ? 1_000 : 0) + (targetInLink ? 500 : 0);
}

export function findLinkedInPostRoot(
  documentRef: Document,
  target: PostTarget,
): LinkedInPostRoot | null {
  const candidates = new Set<HTMLElement>();
  for (const root of documentRef.querySelectorAll<HTMLElement>(
    '[componentkey^="update-card-focus"], [role="listitem"]',
  )) {
    if (
      root.matches('[componentkey^="update-card-focus"]') ||
      root.querySelector('[componentkey*="commentsSectionContainer"], [data-testid*="commentList"]')
    ) {
      candidates.add(root);
    }
  }

  for (const section of documentRef.querySelectorAll<HTMLElement>(
    '[componentkey*="commentsSectionContainer"], [data-testid*="commentList"]',
  )) {
    candidates.add(
      section.closest<HTMLElement>('[componentkey^="update-card-focus"], [role="listitem"]') ?? section,
    );
  }

  const scored = [...candidates]
    .map((root) => ({ root, score: rootScore(root, target) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].root;

  const targetLink = target.postId
    ? [...documentRef.querySelectorAll<HTMLAnchorElement>('a[href]')].find((anchor) =>
      (anchor.getAttribute('href') ?? '').includes(target.postId ?? ''))
    : undefined;
  if (targetLink) {
    return targetLink.closest<HTMLElement>('[componentkey^="update-card-focus"], [role="listitem"]')
      ?? targetLink.closest<HTMLElement>('main');
  }
  return documentRef.querySelector<HTMLElement>('main');
}

function directTextSegments(element: Element): string[] {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const segments: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = cleanText(node.nodeValue);
    if (text) segments.push(text);
    node = walker.nextNode();
  }
  return segments;
}

function looksLikeProfileUrl(raw: string, baseUrl: string): boolean {
  try {
    const url = new URL(raw, baseUrl);
    return url.hostname.endsWith('linkedin.com') && /^\/(?:in|company)\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function findAuthor(
  wrapper: HTMLElement,
  target: PostTarget,
): { name: string; profileUrl?: string; element?: HTMLAnchorElement } {
  const links = [...wrapper.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((anchor) =>
    looksLikeProfileUrl(anchor.getAttribute('href') ?? '', target.canonicalUrl));
  for (const link of links) {
    const visibleName = [...link.querySelectorAll('[aria-hidden="true"]')]
      .flatMap((element) => directTextSegments(element))
      .find((text) => text && !/^(?:1st|2nd|3rd|Follow)$/i.test(text));
    const fallback = directTextSegments(link).find(
      (text) => text && !/^(?:1st|2nd|3rd|Follow|View profile.*)$/i.test(text),
    );
    const name = visibleName ?? fallback;
    if (name) {
      return {
        name,
        profileUrl: sanitizedUrl(link.getAttribute('href') ?? link.href, target.canonicalUrl),
        element: link,
      };
    }
  }
  return { name: 'Unknown author' };
}

function findCommentText(wrapper: HTMLElement): string {
  const body = wrapper.querySelector<HTMLElement>('[data-testid="expandable-text-box"]');
  if (!body) return '';
  return cleanText(body.innerText || body.textContent);
}

function findTimestamp(wrapper: HTMLElement): { display?: string; iso?: string } {
  const exact = wrapper.querySelector<HTMLTimeElement>('time[datetime]');
  if (exact?.dateTime) {
    const parsed = Date.parse(exact.dateTime);
    return {
      display: cleanText(exact.textContent) || exact.dateTime,
      iso: Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString(),
    };
  }

  const authorLinks = new Set(
    [...wrapper.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]')],
  );
  for (const element of wrapper.querySelectorAll<HTMLElement>('span, time')) {
    if ([...authorLinks].some((link) => link.contains(element))) continue;
    if (element.closest('button, [role="button"], [data-testid="expandable-text-box"]')) continue;
    const text = cleanText(element.textContent);
    if (
      /^(?:\d+\s*)?(?:s|m|h|d|w|mo|yr)s?(?:\s*•\s*Edited)?$/i.test(text) ||
      /^(?:just now|\d+\s+(?:second|minute|hour|day|week|month|year)s? ago)(?:\s*•\s*Edited)?$/i.test(text)
    ) {
      return { display: text };
    }
  }
  return {};
}

function findReactionCount(wrapper: HTMLElement): number | undefined {
  const control = [...wrapper.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (element) => /reactions?/i.test(elementLabel(element)),
  );
  return control ? parseMetricCount(elementLabel(control)) : undefined;
}

function commentPermalink(identity: ReturnType<typeof commentIdentity>, target: PostTarget): string | undefined {
  if (!identity.activityUrn || !identity.urn) return undefined;
  const url = new URL(`/feed/update/${identity.activityUrn}/`, target.canonicalUrl);
  url.searchParams.set('commentUrn', identity.urn);
  return url.toString();
}

function collectAttachments(
  wrapper: HTMLElement,
  target: PostTarget,
): { types: CommentRecord['attachmentTypes']; urls: string[] } {
  const types = new Set<CommentRecord['attachmentTypes'][number]>();
  const urls = new Set<string>();
  const body = wrapper.querySelector<HTMLElement>('[data-testid="expandable-text-box"]');

  for (const anchor of wrapper.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const raw = anchor.getAttribute('href') ?? anchor.href;
    if (looksLikeProfileUrl(raw, target.canonicalUrl)) continue;
    const url = sanitizedUrl(raw, target.canonicalUrl);
    if (!url || /linkedin\.com\/feed\/?$/i.test(url)) continue;
    if (anchor.querySelector('img')) types.add('photo');
    else if (anchor.querySelector('video') || /\/video\//i.test(url)) types.add('video');
    else if (body?.contains(anchor)) types.add('link');
    else continue;
    urls.add(url);
  }

  for (const media of wrapper.querySelectorAll<HTMLElement>('img[src], video[src], video source[src]')) {
    const profileLink = media.closest<HTMLAnchorElement>('a[href]');
    if (profileLink && looksLikeProfileUrl(profileLink.getAttribute('href') ?? '', target.canonicalUrl)) {
      continue;
    }
    const label = cleanText(media.getAttribute('alt') || media.getAttribute('aria-label'));
    if (/profile photo|profile picture|emoji|reaction/i.test(label)) continue;
    const url = sanitizedUrl(media.getAttribute('src') ?? undefined, target.canonicalUrl);
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

function inferReplies(wrappers: HTMLElement[]): Array<{ depth: number; parentId?: string }> {
  const measurements = wrappers.map((wrapper) => {
    const content = wrapper.querySelector<HTMLElement>('[data-testid="expandable-text-box"]') ?? wrapper;
    const rect = content.getBoundingClientRect();
    return { width: rect.width, left: rect.left };
  });
  const usableWidths = measurements.map(({ width }) => width).filter((width) => width > 0);
  const widest = usableWidths.length ? Math.max(...usableWidths) : 0;
  const leftmost = measurements.length ? Math.min(...measurements.map(({ left }) => left)) : 0;
  let lastTopLevelId: string | undefined;

  return wrappers.map((wrapper, index) => {
    const identity = commentIdentity(wrapper);
    const measurement = measurements[index] ?? { width: 0, left: 0 };
    const explicitDepth = Number.parseInt(wrapper.getAttribute('data-comment-depth') ?? '', 10);
    const isReply = explicitDepth > 0 ||
      (widest > 0 && widest - measurement.width > 20) ||
      (widest > 0 && measurement.left - leftmost > 20);
    if (!isReply) {
      lastTopLevelId = identity.id;
      return { depth: 0 };
    }
    return { depth: 1, parentId: lastTopLevelId };
  });
}

export function extractLinkedInComments(
  root: LinkedInPostRoot,
  target: PostTarget,
): CommentRecord[] {
  const wrappers = commentWrappers(root);
  const hierarchy = inferReplies(wrappers);
  const records = wrappers.map((wrapper, index): CommentRecord => {
    const identity = commentIdentity(wrapper);
    const author = findAuthor(wrapper, target);
    const text = findCommentText(wrapper);
    const timestamp = findTimestamp(wrapper);
    const attachments = collectAttachments(wrapper, target);
    const warnings: string[] = [];
    if (!identity.id) warnings.push('LinkedIn did not expose a comment URN; a fallback ID was used.');
    if (!text) warnings.push('No comment text was detected; this may be an attachment-only comment.');
    if (!timestamp.display) warnings.push('No timestamp was exposed.');
    const id = identity.id ?? `fallback-${stableHash(
      [target.canonicalUrl, author.name, timestamp.display, text, attachments.urls.join('|')].join('::'),
    )}`;
    const relation = hierarchy[index] ?? { depth: 0 };
    return {
      id,
      parentId: relation.parentId,
      depth: relation.parentId ? 1 : relation.depth,
      type: relation.parentId ? 'reply' : 'comment',
      sequence: index + 1,
      authorName: author.name,
      authorProfileUrl: author.profileUrl,
      text,
      publishedAtDisplay: timestamp.display,
      publishedAtIso: timestamp.iso,
      edited: /(?:^|\s)Edited(?:$|\s)/i.test(cleanText(wrapper.textContent)),
      reactionCount: findReactionCount(wrapper),
      commentUrl: commentPermalink(identity, target),
      attachmentTypes: attachments.types,
      attachmentUrls: attachments.urls,
      postType: 'linkedin-post',
      parseWarnings: warnings,
    };
  });

  const replyCounts = new Map<string, number>();
  for (const record of records) {
    if (record.parentId) replyCounts.set(record.parentId, (replyCounts.get(record.parentId) ?? 0) + 1);
  }
  return records.map((record) => ({
    ...record,
    replyCountDisplayed: record.parentId ? undefined : replyCounts.get(record.id),
  }));
}

function sortName(element: Element | undefined): LinkedInCommentSort | undefined {
  if (!element) return undefined;
  const label = elementLabel(element).toLocaleLowerCase();
  return COMMENT_SORTS.find((sort) => label.startsWith(sort.toLocaleLowerCase()));
}

export function findLinkedInCurrentSort(root: LinkedInPostRoot): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (element) => !isHidden(element) && Boolean(sortName(element)),
  );
}

export function getLinkedInCurrentSort(root: LinkedInPostRoot): LinkedInCommentSort | undefined {
  return sortName(findLinkedInCurrentSort(root));
}

export function findMostRecentOption(documentRef: Document): HTMLElement | undefined {
  return [...documentRef.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"]',
  )].find((element) => !isHidden(element) && sortName(element) === 'Most recent');
}

export function findLinkedInSortRevealAction(
  root: LinkedInPostRoot,
): LinkedInExpandAction | undefined {
  const actions = findLinkedInExpandActions(root).filter(({ kind }) => kind === 'comments');
  return actions.find(({ label }) => /^(?:See|Load|Show)\b/i.test(label)) ?? actions[0];
}

function displayedCommentCount(root: LinkedInPostRoot): number | undefined {
  for (const control of root.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    const label = elementLabel(control);
    if (!/^\d[\d,.]*\s*[KMB]?\s+comments?/i.test(label)) continue;
    const count = parseMetricCount(label);
    if (count !== undefined) return count;
  }
  return undefined;
}

export function extractLinkedInPostMetadata(root: LinkedInPostRoot): PostMetadata {
  const documentRef = root instanceof Document ? root : root.ownerDocument;
  const commentSection = root.querySelector(
    `${COMMENT_SELECTOR}, [componentkey*="commentsSectionContainer"], ` +
    '[data-testid*="commentList"], [componentkey^="expanded"][id^="expanded"]',
  );
  const authorLink = [...root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]')]
    .find((link) => !commentSection?.contains(link) && cleanText(link.textContent));
  return {
    pageTitle: documentRef.title,
    postAuthor: authorLink ? directTextSegments(authorLink).find(Boolean) : undefined,
    containerName: documentRef.title || undefined,
    displayedCommentCount: displayedCommentCount(root),
    currentSort: getLinkedInCurrentSort(root),
    interfaceLanguage: documentRef.documentElement.lang || 'unknown',
    documentDirection: documentRef.documentElement.dir || 'ltr',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
  };
}

function closestPrecedingCommentId(control: HTMLElement, root: LinkedInPostRoot): string {
  const containing = control.closest<HTMLElement>(COMMENT_SELECTOR);
  if (containing) return commentIdentity(containing).id ?? 'unknown';
  let result = 'post';
  for (const wrapper of commentWrappers(root)) {
    const relation = wrapper.compareDocumentPosition(control);
    if (relation & 4) result = commentIdentity(wrapper).id ?? result;
    else break;
  }
  return result;
}

export function findLinkedInExpandActions(
  root: LinkedInPostRoot,
): LinkedInExpandAction[] {
  const actions: LinkedInExpandAction[] = [];
  const counters = new Map<string, number>();
  const hasCommentSection = hasLinkedInCommentSection(root);

  for (const control of root.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (isHidden(control) || control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true') {
      continue;
    }
    const label = elementLabel(control);
    let kind: LinkedInExpandAction['kind'] | undefined;
    if (
      control.closest(COMMENT_SELECTOR) &&
      (
        /^(?:Show|See|\.\.\.|…)[\s\u00a0]*more$/i.test(label) ||
        control.getAttribute('data-testid') === 'expandable-text-button'
      )
    ) kind = 'text';
    else if (/^(?:See|Load|Show)\s+(?:\d+\s+)?(?:more|previous)\s+comments?$/i.test(label)) {
      kind = 'comments';
    } else if (
      /^(?:See|Load|Show)\s+(?:\d+\s+)?(?:more|previous)\s+repl(?:y|ies)$/i.test(label) ||
      /^\d+\s+(?:more\s+)?repl(?:y|ies)$/i.test(label)
    ) {
      kind = 'replies';
    } else if (!hasCommentSection && /^\d[\d,.]*\s*[KMB]?\s+comments?/i.test(label)) {
      kind = 'comments';
    }
    if (!kind) continue;
    const context = closestPrecedingCommentId(control, root);
    const signature = `${kind}:${context}:${label}`;
    const occurrence = (counters.get(signature) ?? 0) + 1;
    counters.set(signature, occurrence);
    actions.push({ element: control, kind, label, key: `${signature}:${occurrence}` });
  }

  const priority: Record<LinkedInExpandAction['kind'], number> = { text: 0, comments: 1, replies: 2 };
  return actions.sort((a, b) => priority[a.kind] - priority[b.kind]);
}

export function detectLinkedInBlockingState(documentRef: Document): string | undefined {
  if (/\/checkpoint\//i.test(documentRef.location.pathname)) return 'LinkedIn is showing a security checkpoint.';
  if (/\/login/i.test(documentRef.location.pathname) || documentRef.querySelector('form[action*="login"]')) {
    return 'LinkedIn requires you to sign in.';
  }
  if (documentRef.querySelector('iframe[title*="captcha" i], input[name*="captcha" i]')) {
    return 'LinkedIn is showing a CAPTCHA.';
  }
  return undefined;
}
