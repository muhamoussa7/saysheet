import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  createWorkbook,
  safeSpreadsheetText,
  splitForExcel,
  workbookFilename,
} from '../lib/export-workbook';
import type { JobBundle, StoredComment } from '../lib/types';

function comment(id: string, sequence: number, parentId?: string): StoredComment {
  return {
    key: `job::${id}`,
    jobId: 'job',
    fingerprint: id,
    updatedAt: '2026-09-02T12:00:00.000Z',
    id,
    parentId,
    depth: parentId ? 1 : 0,
    type: parentId ? 'reply' : 'comment',
    sequence,
    authorName: id === 'c1' ? '=DANGEROUS()' : 'Reply Author',
    authorProfileUrl: 'https://www.facebook.com/example',
    text: id === 'c1' ? 'Hello\nمرحبا 😀' : 'Reply text',
    publishedAtDisplay: 'Friday, August 21, 2026 at 11:34 AM',
    publishedAtIso: '2026-08-21T09:34:00.000Z',
    edited: false,
    reactionCount: 2,
    replyCountDisplayed: parentId ? undefined : 1,
    commentUrl: `https://www.facebook.com/groups/1/posts/2/?comment_id=${id}`,
    attachmentTypes: id === 'c1' ? ['photo'] : [],
    attachmentUrls: id === 'c1' ? ['https://scontent.example/photo.jpg'] : [],
    postType: 'group',
    parseWarnings: [],
  };
}

function bundle(comments: StoredComment[]): JobBundle {
  return {
    job: {
      id: 'job',
      target: {
        platform: 'facebook',
        canonicalUrl: 'https://www.facebook.com/groups/1/posts/2/',
        originalUrl: 'https://www.facebook.com/groups/1/posts/2/?ref=share',
        type: 'group',
        groupId: '1',
        postId: '2',
      },
      mode: 'manual',
      status: 'completed',
      tabId: 4,
      rowLimit: 10_000,
      action: 'Complete',
      completionReason: 'Test complete',
      isPartial: false,
      counters: {
        uniqueTotal: comments.length,
        topLevel: comments.filter((item) => !item.parentId).length,
        replies: comments.filter((item) => item.parentId).length,
        duplicates: 0,
        failedControls: 0,
      },
      createdAt: '2026-09-02T12:00:00.000Z',
      startedAt: '2026-09-02T12:00:01.000Z',
      completedAt: '2026-09-02T12:00:02.000Z',
      updatedAt: '2026-09-02T12:00:02.000Z',
    },
    comments,
    logs: [
      {
        jobId: 'job',
        timestamp: '2026-09-02T12:00:00.000Z',
        severity: 'info',
        code: 'TEST',
        message: 'Created for test',
      },
    ],
  };
}

describe('Excel export', () => {
  it('protects formula-like text and splits oversized cells', () => {
    expect(safeSpreadsheetText('=SUM(1,2)')).toBe("'=SUM(1,2)");
    expect(safeSpreadsheetText('normal')).toBe('normal');
    expect(splitForExcel('x'.repeat(65_000))).toHaveLength(3);
  });

  it('creates an organized workbook with comments, hierarchy, summary, and log', async () => {
    const source = bundle([comment('r1', 2, 'c1'), comment('c1', 1)]);
    const buffer = await createWorkbook(source);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Comments',
      'Attachments',
      'Post Summary',
      'Run Log',
    ]);
    const sheet = workbook.getWorksheet('Comments')!;
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(2).getCell(2).value).toBe('c1');
    expect(sheet.getRow(2).getCell(6).value).toBe("'=DANGEROUS()");
    expect(sheet.getRow(2).getCell(8).value).toBe('Hello\nمرحبا 😀');
    expect(sheet.getRow(3).getCell(3).value).toBe('c1');
    const attachments = workbook.getWorksheet('Attachments')!;
    expect(attachments.rowCount).toBe(2);
    expect(attachments.getRow(2).getCell(5).value).toEqual({
      text: 'Open attachment',
      hyperlink: 'https://scontent.example/photo.jpg',
    });
    expect(workbookFilename(source)).toMatch(/^facebook-comments_group_2_.*\.xlsx$/);
  });

  it('handles a 10,000-row export', async () => {
    const comments = Array.from({ length: 10_000 }, (_, index) =>
      comment(`comment-${index + 1}`, index + 1),
    );
    const buffer = await createWorkbook(bundle(comments));
    expect(buffer.byteLength).toBeGreaterThan(100_000);
  }, 60_000);
});
