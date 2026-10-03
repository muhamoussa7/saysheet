import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectBlockingState,
  extractComments,
  extractPostMetadata,
  findAllCommentsOption,
  findCommentScroller,
  findCurrentSort,
  findExpandActions,
  findPostRoot,
  getCurrentSort,
} from '../lib/collector/dom';
import type { PostTarget } from '../lib/types';

const target: PostTarget = {
  platform: 'facebook',
  canonicalUrl: 'https://www.facebook.com/groups/1/posts/2/',
  originalUrl: 'https://www.facebook.com/groups/1/posts/2/?ref=share',
  type: 'group',
  groupId: '1',
  postId: '2',
};

beforeEach(() => {
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.title = 'Example group post';
  document.body.innerHTML = `
    <main>
      <article role="article" aria-label="Comment by Unrelated Person a day ago">
        <a href="/someone">Unrelated Person</a>
        <a aria-label="Monday, August 17, 2026 at 10:00 AM" href="/other/posts/9/?comment_id=outside">1d</a>
        <div>Not part of the target post</div><button aria-label="Like">Like</button>
      </article>
    </main>
    <div role="dialog" aria-label="Example Person's Post">
      <h3><a href="/groups/1/">Example Group</a></h3>
      <a href="/groups/1/posts/2/">Post permalink</a>
      <button aria-label="Leave a comment"><span>2</span></button>
      <button aria-label="Most relevant">Most relevant</button>

      <article role="article" aria-label="Comment by Alice Example a week ago">
        <a href="/groups/1/user/10/">Alice Example</a>
        <span>·</span>
        <a aria-label="Friday, August 21, 2026 at 11:34 AM" href="/groups/1/posts/2/?comment_id=c1&__tn__=tracking"><span>1w</span></a>
        <div dir="auto">First line</div>
        <div dir="auto">Second line with <a href="https://example.com/details">a link</a></div>
        <a href="https://www.facebook.com/photo/?fbid=photo1"><img src="https://scontent.example/photo.jpg" alt="Attachment"></a>
        <button aria-label="Hide or report this"></button>
        <button aria-label="Like"></button>
        <button aria-label="Reply"></button>
        <button aria-label="2 reactions; see who reacted to this">2</button>
      </article>
      <button aria-label="View 1 reply">View 1 reply</button>

      <article role="article" aria-label="Reply by Bob Example a week ago">
        <a href="/groups/1/user/11/">Bob Example</a>
        <a href="/groups/1/user/11/"><img src="https://scontent.example/avatar.jpg" alt="Bob's profile picture"></a>
        <a aria-label="Friday, August 21, 2026 at 12:00 PM" href="/groups/1/posts/2/?comment_id=c1&reply_comment_id=r1"><span>1w</span></a>
        <div dir="auto">A nested reply</div>
        <a href="https://www.facebook.com/watch/?v=video1"><video src="https://video.example/clip.mp4"></video></a>
        <button aria-label="Hide or report this"></button>
        <button aria-label="Like"></button>
        <button aria-label="Reply"></button>
      </article>
      <button aria-label="View more comments">View more comments</button>
    </div>
  `;
});

describe('Facebook DOM parser', () => {
  it('scopes extraction to the target dialog and preserves hierarchy', () => {
    const root = findPostRoot(document, target);
    expect(root).not.toBeNull();
    const comments = extractComments(root!, target);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: 'c1',
      type: 'comment',
      authorName: 'Alice Example',
      text: 'First line\nSecond line with a link',
      reactionCount: 2,
      replyCountDisplayed: 1,
    });
    expect(comments[0]?.publishedAtIso).toBe(new Date(2026, 7, 21, 11, 34).toISOString());
    expect(comments[0]?.commentUrl).not.toContain('__tn__');
    expect(comments[0]?.attachmentTypes).toContain('photo');
    expect(comments[1]).toMatchObject({
      id: 'r1',
      parentId: 'c1',
      depth: 1,
      type: 'reply',
      authorName: 'Bob Example',
      text: 'A nested reply',
    });
    expect(comments[1]?.attachmentTypes).toContain('video');
    expect(comments[1]?.attachmentUrls).toContain('https://video.example/clip.mp4');
    expect(comments[1]?.attachmentUrls).not.toContain('https://scontent.example/avatar.jpg');
    expect(comments.some((comment) => comment.id === 'outside')).toBe(false);
  });

  it('finds English reply and comment loaders', () => {
    const root = findPostRoot(document, target)!;
    const actions = findExpandActions(root, target);
    expect(actions.map((action) => action.kind)).toEqual(['comments', 'replies']);
    expect(actions.map((action) => action.label)).toEqual([
      'View more comments',
      'View 1 reply',
    ]);
  });

  it('finds the nested comments scroller and recognizes additional loader labels', () => {
    const root = findPostRoot(document, target)! as HTMLElement;
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const firstComment = root.querySelector('[aria-label^="Comment by"]')!;
    root.insertBefore(scroller, firstComment);
    scroller.append(firstComment);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 5_000 },
    });
    root.insertAdjacentHTML(
      'beforeend',
      '<button aria-label="View previous replies">View previous replies</button><button aria-label="20 more comments">20 more comments</button>',
    );

    expect(findCommentScroller(root)).toBe(scroller);
    expect(findExpandActions(root, target).map((action) => action.label)).toEqual([
      'View more comments',
      '20 more comments',
      'View 1 reply',
      'View previous replies',
    ]);
  });

  it('extracts post metadata without collecting unrelated feed counts', () => {
    const metadata = extractPostMetadata(findPostRoot(document, target)!);
    expect(metadata.pageTitle).toBe('Example group post');
    expect(metadata.currentSort).toBe('Most relevant');
    expect(metadata.displayedCommentCount).toBe(2);
    expect(metadata.interfaceLanguage).toBe('en');
  });

  it('recognizes Facebook sort options that include descriptive text', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div role="menu">
        <div role="menuitem">Most relevant<span>Show the most engaging comments first.</span></div>
        <div role="menuitem">All comments<span>Show all comments, including potential spam.</span></div>
      </div>`,
    );
    const root = findPostRoot(document, target)!;

    expect(getCurrentSort(root)).toBe('Most relevant');
    expect(findCurrentSort(root)?.textContent).toBe('Most relevant');
    expect(findAllCommentsOption(document)?.textContent).toContain(
      'All commentsShow all comments',
    );
  });

  it('detects security and CAPTCHA states', () => {
    expect(detectBlockingState(document)).toBeUndefined();
    document.body.insertAdjacentHTML('beforeend', '<iframe title="Captcha challenge"></iframe>');
    expect(detectBlockingState(document)).toBe('Facebook is showing a CAPTCHA.');
  });
});
