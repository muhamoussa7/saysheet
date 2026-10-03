import type { Platform, PostTarget, PostType } from './types';

const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
]);

const LINKEDIN_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

const TRACKING_PARAMS = new Set([
  '__cft__[0]',
  '__tn__',
  'ref',
  'refid',
  'mibextid',
  'sfnsn',
  'fbclid',
  'acontext',
  'locale',
]);

export interface ParsedPostUrl {
  ok: true;
  target: PostTarget;
}

export interface InvalidPostUrl {
  ok: false;
  error: string;
}

export type PostUrlResult = ParsedPostUrl | InvalidPostUrl;

function platformForHostname(hostname: string): Platform | undefined {
  const normalized = hostname.toLowerCase();
  if (FACEBOOK_HOSTS.has(normalized)) return 'facebook';
  if (LINKEDIN_HOSTS.has(normalized)) return 'linkedin';
  return undefined;
}

function normalizePath(pathname: string): string {
  const decoded = pathname.replace(/\/{2,}/g, '/');
  return decoded !== '/' && decoded.endsWith('/') ? decoded : `${decoded}/`;
}

function classify(url: URL): {
  type: PostType;
  postId?: string;
  groupId?: string;
  ownerId?: string;
} {
  const path = url.pathname;
  const group = path.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([^/]+)/i);
  if (group) {
    return {
      type: 'group',
      groupId: group[1],
      postId: group[2],
    };
  }

  const reel = path.match(/^\/reel\/([^/]+)/i);
  if (reel) return { type: 'reel', postId: reel[1] };

  if (/^\/photo(?:\.php)?\/?$/i.test(path)) {
    return { type: 'photo', postId: url.searchParams.get('fbid') ?? undefined };
  }

  const videoPath = path.match(/\/(?:videos|watch)\/([^/]+)/i);
  if (videoPath) return { type: 'video', postId: videoPath[1] };
  if (/^\/watch\/?$/i.test(path) && url.searchParams.get('v')) {
    return { type: 'video', postId: url.searchParams.get('v') ?? undefined };
  }

  if (/^\/(?:permalink|story)\.php\/?$/i.test(path)) {
    return {
      type: 'profile',
      postId: url.searchParams.get('story_fbid') ?? undefined,
      ownerId: url.searchParams.get('id') ?? undefined,
    };
  }

  const namedPost = path.match(/^\/([^/]+)\/posts\/([^/]+)/i);
  if (namedPost) {
    return {
      type: /^\d+$/.test(namedPost[1] ?? '') ? 'profile' : 'page',
      ownerId: namedPost[1],
      postId: namedPost[2],
    };
  }

  const namedVideo = path.match(/^\/([^/]+)\/videos\/([^/]+)/i);
  if (namedVideo) {
    return { type: 'video', ownerId: namedVideo[1], postId: namedVideo[2] };
  }

  return { type: 'unknown' };
}

function preserveIdentifyingParams(url: URL, type: PostType): void {
  const allowedByType: Record<PostType, Set<string>> = {
    group: new Set(),
    page: new Set(),
    profile: new Set(['story_fbid', 'id']),
    photo: new Set(['fbid', 'set']),
    video: new Set(['v']),
    reel: new Set(),
    'linkedin-post': new Set(),
    unknown: new Set(['story_fbid', 'id', 'fbid', 'set', 'v']),
  };

  const allowed = allowedByType[type];
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || !allowed.has(key)) url.searchParams.delete(key);
  }
}

export function parseFacebookPostUrl(raw: string): PostUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter or open a Facebook post URL.' };

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: 'This is not a valid URL.' };
  }

  const hostname = url.hostname.toLowerCase();
  if (!FACEBOOK_HOSTS.has(hostname)) {
    return { ok: false, error: 'The URL must be on facebook.com.' };
  }

  if (/^\/(?:share|sharer)/i.test(url.pathname)) {
    return {
      ok: false,
      error: 'Open the shared link first so Facebook resolves it to the original post.',
    };
  }

  url.protocol = 'https:';
  url.hostname = 'www.facebook.com';
  url.hash = '';
  url.pathname = normalizePath(url.pathname);

  const classification = classify(url);
  preserveIdentifyingParams(url, classification.type);

  const hasPostIdentity =
    Boolean(classification.postId) ||
    (classification.type === 'unknown' && url.searchParams.has('story_fbid'));
  if (!hasPostIdentity) {
    return {
      ok: false,
      error:
        'This does not look like a supported post, photo, video, or reel permalink.',
    };
  }

  return {
    ok: true,
    target: {
      platform: 'facebook',
      canonicalUrl: url.toString(),
      originalUrl: trimmed,
      ...classification,
    },
  };
}

export function parseLinkedInPostUrl(raw: string): PostUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter or open a LinkedIn post URL.' };

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: 'This is not a valid URL.' };
  }

  if (!LINKEDIN_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: 'The URL must be on linkedin.com.' };
  }

  const feedUpdate = url.pathname.match(
    /^\/feed\/update\/(urn:li:(?:activity|share|ugcPost):([^/?]+))\/?$/i,
  );
  const postSlug = url.pathname.match(/^\/posts\/([^/?]+)\/?$/i)?.[1];
  if (!feedUpdate && !postSlug) {
    return {
      ok: false,
      error: 'Open a LinkedIn post permalink (/posts/… or /feed/update/…).',
    };
  }

  const activityId = feedUpdate?.[2] ?? postSlug?.match(/activity[-_:](\d{8,})/i)?.[1];
  url.protocol = 'https:';
  url.hostname = 'www.linkedin.com';
  url.hash = '';
  url.search = '';
  url.pathname = normalizePath(url.pathname);

  return {
    ok: true,
    target: {
      platform: 'linkedin',
      canonicalUrl: url.toString(),
      originalUrl: trimmed,
      type: 'linkedin-post',
      postId: activityId ?? postSlug,
    },
  };
}

export function parsePostUrl(raw: string): PostUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter or open a Facebook or LinkedIn post URL.' };
  try {
    const candidate = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const platform = platformForHostname(candidate.hostname);
    if (platform === 'facebook') return parseFacebookPostUrl(trimmed);
    if (platform === 'linkedin') return parseLinkedInPostUrl(trimmed);
    return { ok: false, error: 'The URL must be on facebook.com or linkedin.com.' };
  } catch {
    return { ok: false, error: 'This is not a valid URL.' };
  }
}

export function samePost(a: string, b: string): boolean {
  const first = parsePostUrl(a);
  const second = parsePostUrl(b);
  if (!first.ok || !second.ok || first.target.platform !== second.target.platform) return false;
  if (
    first.target.platform === 'linkedin' &&
    first.target.postId &&
    first.target.postId === second.target.postId
  ) {
    return true;
  }
  return first.target.canonicalUrl === second.target.canonicalUrl;
}

export function shortPostLabel(target: PostTarget): string {
  const id = target.postId ? ` · ${target.postId}` : '';
  const platform = target.platform === 'linkedin' ? 'LinkedIn' : 'Facebook';
  const type = target.type === 'linkedin-post'
    ? 'post'
    : `${target.type[0]?.toUpperCase()}${target.type.slice(1)} post`;
  return `${platform} ${type}${id}`;
}
