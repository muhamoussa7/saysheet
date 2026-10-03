import { describe, expect, it } from 'vitest';
import {
  parseFacebookPostUrl,
  parseLinkedInPostUrl,
  parsePostUrl,
  samePost,
} from '../lib/url';

describe('parseFacebookPostUrl', () => {
  it('normalizes a tracked Facebook group post URL', () => {
    const result = parseFacebookPostUrl(
      'https://www.facebook.com/groups/100000000000001/posts/20000000000000002/?__cft__[0]=token&__tn__=%2CO%2CP-R#comments',
    );

    expect(result).toEqual({
      ok: true,
      target: {
        platform: 'facebook',
        canonicalUrl:
          'https://www.facebook.com/groups/100000000000001/posts/20000000000000002/',
        originalUrl:
          'https://www.facebook.com/groups/100000000000001/posts/20000000000000002/?__cft__[0]=token&__tn__=%2CO%2CP-R#comments',
        type: 'group',
        groupId: '100000000000001',
        postId: '20000000000000002',
      },
    });
  });

  it.each([
    ['https://facebook.com/acme/posts/123', 'page', '123'],
    ['https://m.facebook.com/reel/456/?fbclid=tracking', 'reel', '456'],
    ['https://www.facebook.com/photo/?fbid=789&set=a.4&ref=share', 'photo', '789'],
    ['https://www.facebook.com/watch/?v=321&ref=watch', 'video', '321'],
    ['https://www.facebook.com/permalink.php?story_fbid=654&id=999&ref=share', 'profile', '654'],
  ])('supports %s', (raw, type, postId) => {
    const result = parseFacebookPostUrl(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.type).toBe(type);
      expect(result.target.postId).toBe(postId);
      expect(result.target.canonicalUrl).not.toContain('ref=');
      expect(result.target.canonicalUrl).not.toContain('fbclid=');
    }
  });

  it('rejects a group home page and unresolved share link', () => {
    expect(parseFacebookPostUrl('https://www.facebook.com/groups/123/').ok).toBe(false);
    expect(parseFacebookPostUrl('https://www.facebook.com/share/p/abc/').ok).toBe(false);
  });

  it('compares URLs by normalized post identity', () => {
    expect(
      samePost(
        'https://m.facebook.com/groups/1/posts/2/?ref=share',
        'https://www.facebook.com/groups/1/posts/2/',
      ),
    ).toBe(true);
  });
});

describe('LinkedIn post URLs', () => {
  it('normalizes an official feed activity permalink', () => {
    const result = parseLinkedInPostUrl(
      'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/?commentUrn=tracking&utm_source=share',
    );
    expect(result).toEqual({
      ok: true,
      target: {
        platform: 'linkedin',
        canonicalUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
        originalUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/?commentUrn=tracking&utm_source=share',
        type: 'linkedin-post',
        postId: '7000000000000000001',
      },
    });
  });

  it('supports a public /posts/ permalink and unified detection', () => {
    const raw = 'https://www.linkedin.com/posts/example_topic-activity-7000000000000000001-AbCd?utm_source=share';
    const result = parsePostUrl(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.platform).toBe('linkedin');
      expect(result.target.postId).toBe('7000000000000000001');
      expect(result.target.canonicalUrl).not.toContain('utm_source');
    }
  });

  it('rejects LinkedIn profiles and job pages', () => {
    expect(parseLinkedInPostUrl('https://www.linkedin.com/in/example/').ok).toBe(false);
    expect(parseLinkedInPostUrl('https://www.linkedin.com/jobs/view/123/').ok).toBe(false);
  });

  it('matches /posts and /feed/update links by activity ID', () => {
    expect(
      samePost(
        'https://www.linkedin.com/posts/example_activity-7000000000000000001-AbCd',
        'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
      ),
    ).toBe(true);
  });
});
