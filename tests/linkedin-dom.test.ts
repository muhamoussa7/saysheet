import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectLinkedInBlockingState,
  extractLinkedInComments,
  extractLinkedInPostMetadata,
  findLinkedInExpandActions,
  findLinkedInPostRoot,
  findLinkedInSortRevealAction,
  findMostRecentOption,
  getLinkedInCurrentSort,
} from '../lib/collector/linkedin-dom';
import type { PostTarget } from '../lib/types';

const target: PostTarget = {
  platform: 'linkedin',
  canonicalUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  originalUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  type: 'linkedin-post',
  postId: '7000000000000000001',
};

beforeEach(() => {
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.title = 'Example post | LinkedIn';
  document.body.innerHTML = `
    <main>
      <div role="listitem" componentkey="update-card-focus-example">
        <a href="/posts/example_activity-7000000000000000001-AbCd">Post</a>
        <a href="/in/post-author/"><span aria-hidden="true">Post Author</span></a>
        <div role="button">3 comments3 comments</div>
        <div componentkey="commentsSectionContainer-example">
          <div role="button">Most relevant</div>
          <div id="replaceableComment_urn:li:comment:(urn:li:activity:7000000000000000001,7000000000000000101)">
            <a href="/in/alice/"><img src="https://media.example/alice-avatar.jpg" alt="Alice profile photo"></a>
            <a href="/in/alice/"><span>View profile</span><span aria-hidden="true">Alice Example</span><span>1st</span><span>Founder</span></a>
            <span>2h</span>
            <div data-testid="expandable-text-box">First LinkedIn comment with <a href="https://example.com/article">a link</a>.</div>
            <button aria-label="3 reactions">3 reactions</button>
            <button aria-label="Reply"></button>
            <button>Show more</button>
          </div>
          <button role="button">See 1 more comment</button>
          <div data-comment-depth="1" id="replaceableComment_urn:li:comment:(urn:li:activity:7000000000000000001,7000000000000000102)">
            <a href="/in/bob/"><span aria-hidden="true">Bob Example</span><span>2nd</span></a>
            <span>1h • Edited</span>
            <div data-testid="expandable-text-box">A LinkedIn reply</div>
            <button aria-label="Open attachment"><img src="https://media.example/reply-photo.jpg" alt="Comment attachment"></button>
            <button aria-label="Reply"></button>
          </div>
          <button role="button">See previous replies</button>
        </div>
      </div>
    </main>
    <div role="menu">
      <div role="menuitem">Most relevant<span>See most relevant comments</span></div>
      <div role="menuitem">Most recent<span>See all comments, the most recent comments are first</span></div>
    </div>
  `;
});

describe('LinkedIn DOM parser', () => {
  it('scopes the post and extracts comment/reply hierarchy', () => {
    const root = findLinkedInPostRoot(document, target);
    expect(root).not.toBeNull();
    const comments = extractLinkedInComments(root!, target);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: '7000000000000000101',
      type: 'comment',
      authorName: 'Alice Example',
      text: 'First LinkedIn comment with a link.',
      publishedAtDisplay: '2h',
      reactionCount: 3,
      replyCountDisplayed: 1,
    });
    expect(comments[0]?.commentUrl).toContain('commentUrn=urn%3Ali%3Acomment');
    expect(comments[0]?.attachmentTypes).toContain('link');
    expect(comments[1]).toMatchObject({
      id: '7000000000000000102',
      parentId: '7000000000000000101',
      type: 'reply',
      authorName: 'Bob Example',
      text: 'A LinkedIn reply',
      edited: true,
    });
    expect(comments[1]?.attachmentTypes).toContain('photo');
    expect(comments[1]?.attachmentUrls).toContain('https://media.example/reply-photo.jpg');
    expect(comments[0]?.attachmentUrls).not.toContain('alice-avatar');
  });

  it('finds comment sorting and descriptive Most recent option text', () => {
    const root = findLinkedInPostRoot(document, target)!;
    expect(getLinkedInCurrentSort(root)).toBe('Most relevant');
    expect(findMostRecentOption(document)?.textContent).toContain(
      'Most recentSee all comments',
    );
  });

  it('reveals comment sorting through the current LinkedIn more-comments control', () => {
    document.body.innerHTML = `
      <main>
        <div componentkey="update-card-focus-current">
          <a href="/feed/update/urn:li:activity:7000000000000000001/">Post</a>
          <div role="button">25 comments</div>
          <div id="replaceableComment_urn:li:comment:(urn:li:ugcPost:7500800000000000000,7500900000000000000)">
            <a href="/in/alice/"><span aria-hidden="true">Alice</span></a>
            <div data-testid="expandable-text-box">Visible comment</div>
            <button data-testid="expandable-text-button">… more</button>
          </div>
          <div role="button">See 24 more comments</div>
        </div>
      </main>
    `;
    const root = findLinkedInPostRoot(document, target)!;
    const actions = findLinkedInExpandActions(root);
    expect(getLinkedInCurrentSort(root)).toBeUndefined();
    expect(actions.map(({ kind, label }) => [kind, label])).toEqual([
      ['text', '… more'],
      ['comments', 'See 24 more comments'],
    ]);
    expect(findLinkedInSortRevealAction(root)?.element.textContent).toBe('See 24 more comments');
  });

  it('does not select a Most recent option inside a hidden menu', () => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.hidden = true;
    expect(findMostRecentOption(document)).toBeUndefined();
    menu.hidden = false;
    expect(findMostRecentOption(document)).toBeDefined();
  });

  it('finds text, comment, and reply loaders in priority order', () => {
    const root = findLinkedInPostRoot(document, target)!;
    expect(findLinkedInExpandActions(root).map(({ kind, label }) => [kind, label])).toEqual([
      ['text', 'Show more'],
      ['comments', 'See 1 more comment'],
      ['replies', 'See previous replies'],
    ]);
  });

  it('extracts LinkedIn metadata and blocking states', () => {
    const root = findLinkedInPostRoot(document, target)!;
    expect(extractLinkedInPostMetadata(root)).toMatchObject({
      pageTitle: 'Example post | LinkedIn',
      displayedCommentCount: 3,
      currentSort: 'Most relevant',
      interfaceLanguage: 'en',
    });
    expect(detectLinkedInBlockingState(document)).toBeUndefined();
    document.body.insertAdjacentHTML('beforeend', '<iframe title="Captcha challenge"></iframe>');
    expect(detectLinkedInBlockingState(document)).toBe('LinkedIn is showing a CAPTCHA.');
  });
});
