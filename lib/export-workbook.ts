import ExcelJS from 'exceljs';
import type { CellValue, Column } from 'exceljs';
import type { JobBundle, StoredComment } from './types';

const EXCEL_TEXT_LIMIT = 32_767;
const SAFE_TEXT_CHUNK = 32_000;
const DANGEROUS_FORMULA_PREFIX = /^\s*[=+\-@]/;

export function safeSpreadsheetText(value: string | undefined): string {
  if (!value) return '';
  const withoutControls = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return DANGEROUS_FORMULA_PREFIX.test(withoutControls) ? `'${withoutControls}` : withoutControls;
}

export function splitForExcel(value: string | undefined): string[] {
  const safe = safeSpreadsheetText(value);
  if (safe.length <= EXCEL_TEXT_LIMIT) return [safe];
  const chunks: string[] = [];
  for (let index = 0; index < safe.length; index += SAFE_TEXT_CHUNK) {
    chunks.push(safe.slice(index, index + SAFE_TEXT_CHUNK));
  }
  return chunks;
}

function validHyperlink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hyperlink(text: string, rawUrl: string | undefined): CellValue {
  const url = validHyperlink(rawUrl);
  return url ? { text: safeSpreadsheetText(text || url), hyperlink: url } : safeSpreadsheetText(text);
}

function orderedComments(comments: StoredComment[]): StoredComment[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const children = new Map<string, StoredComment[]>();
  const roots: StoredComment[] = [];

  for (const comment of comments) {
    if (comment.parentId && byId.has(comment.parentId)) {
      const group = children.get(comment.parentId) ?? [];
      group.push(comment);
      children.set(comment.parentId, group);
    } else {
      roots.push(comment);
    }
  }

  const compare = (a: StoredComment, b: StoredComment) =>
    a.sequence - b.sequence || a.id.localeCompare(b.id);
  roots.sort(compare);
  for (const group of children.values()) group.sort(compare);

  const result: StoredComment[] = [];
  const visited = new Set<string>();
  const visit = (comment: StoredComment, depth: number) => {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    result.push({ ...comment, depth });
    for (const child of children.get(comment.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const orphan of comments.sort(compare)) visit(orphan, orphan.depth);
  return result;
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF176B5B' },
  };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 26;
}

function setupSheet(sheet: ExcelJS.Worksheet): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(sheet.columnCount, 1) },
  };
  styleHeader(sheet.getRow(1));
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber % 2 === 0) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF4F8F7' },
      };
    }
  });
}

export async function createWorkbook(bundle: JobBundle): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Saysheet';
  workbook.created = new Date(bundle.job.createdAt);
  workbook.modified = new Date();
  workbook.subject = `Comments exported from ${bundle.job.target.canonicalUrl}`;

  const ordered = orderedComments(bundle.comments);
  const splitTexts = ordered.map((comment) => splitForExcel(comment.text));
  const overflowColumns = Math.max(0, ...splitTexts.map((parts) => parts.length - 1));
  const commentsSheet = workbook.addWorksheet('Comments', {
    properties: { defaultRowHeight: 20 },
  });

  const columns: Partial<Column>[] = [
    { header: 'Sequence', key: 'sequence', width: 11 },
    { header: 'Comment ID', key: 'commentId', width: 24 },
    { header: 'Parent Comment ID', key: 'parentId', width: 24 },
    { header: 'Depth', key: 'depth', width: 9 },
    { header: 'Type', key: 'type', width: 11 },
    { header: 'Author', key: 'author', width: 25 },
    { header: 'Author Profile', key: 'authorProfile', width: 22 },
    { header: 'Comment Text', key: 'text', width: 70 },
  ];
  for (let index = 1; index <= overflowColumns; index += 1) {
    columns.push({
      header: `Comment Text Overflow ${index}`,
      key: `textOverflow${index}`,
      width: 70,
    });
  }
  columns.push(
    { header: 'Published At (displayed)', key: 'publishedDisplay', width: 31 },
    { header: 'Published At (ISO)', key: 'publishedIso', width: 25 },
    { header: 'Edited', key: 'edited', width: 10 },
    { header: 'Reactions', key: 'reactions', width: 12 },
    { header: 'Displayed Reply Count', key: 'replyCount', width: 21 },
    { header: 'Comment Link', key: 'commentUrl', width: 22 },
    { header: 'Attachment Types', key: 'attachmentTypes', width: 19 },
    { header: 'Attachment URLs', key: 'attachmentUrls', width: 45 },
    { header: 'Post Type', key: 'postType', width: 12 },
    { header: 'Parse Warnings', key: 'warnings', width: 45 },
  );
  commentsSheet.columns = columns;

  ordered.forEach((comment, index) => {
    const textParts = splitTexts[index] ?? [''];
    const row: Record<string, CellValue> = {
      sequence: index + 1,
      commentId: safeSpreadsheetText(comment.id),
      parentId: safeSpreadsheetText(comment.parentId),
      depth: comment.depth,
      type: comment.depth > 0 ? 'reply' : 'comment',
      author: safeSpreadsheetText(comment.authorName),
      authorProfile: hyperlink(comment.authorProfileUrl ? 'Open profile' : '', comment.authorProfileUrl),
      text: textParts[0] ?? '',
      publishedDisplay: safeSpreadsheetText(comment.publishedAtDisplay),
      publishedIso: comment.publishedAtIso ? new Date(comment.publishedAtIso) : '',
      edited: comment.edited ? 'Yes' : 'No',
      reactions: comment.reactionCount ?? '',
      replyCount: comment.replyCountDisplayed ?? '',
      commentUrl: hyperlink(comment.commentUrl ? 'Open comment' : '', comment.commentUrl),
      attachmentTypes: comment.attachmentTypes.join(', '),
      attachmentUrls: safeSpreadsheetText(comment.attachmentUrls.join('\n')),
      postType: comment.postType,
      warnings: safeSpreadsheetText(comment.parseWarnings.join('\n')),
    };
    for (let part = 1; part < textParts.length; part += 1) {
      row[`textOverflow${part}`] = textParts[part] ?? '';
    }
    const added = commentsSheet.addRow(row);
    if (comment.depth > 0) {
      added.getCell('type').font = { italic: true, color: { argb: 'FF475569' } };
    }
  });
  const isoColumn = commentsSheet.getColumn('publishedIso');
  isoColumn.numFmt = 'yyyy-mm-dd hh:mm:ss';
  setupSheet(commentsSheet);

  const attachmentsSheet = workbook.addWorksheet('Attachments');
  attachmentsSheet.columns = [
    { header: 'Sequence', key: 'sequence', width: 11 },
    { header: 'Comment ID', key: 'commentId', width: 24 },
    { header: 'Comment Type', key: 'commentType', width: 14 },
    { header: 'Attachment Type', key: 'attachmentType', width: 20 },
    { header: 'Attachment Link', key: 'attachmentUrl', width: 24 },
    { header: 'Source Comment', key: 'commentUrl', width: 22 },
  ];
  let attachmentSequence = 0;
  for (const comment of ordered) {
    for (const attachmentUrl of comment.attachmentUrls) {
      attachmentSequence += 1;
      attachmentsSheet.addRow({
        sequence: attachmentSequence,
        commentId: safeSpreadsheetText(comment.id),
        commentType: comment.depth > 0 ? 'reply' : 'comment',
        attachmentType: comment.attachmentTypes.join(', ') || 'unknown',
        attachmentUrl: hyperlink('Open attachment', attachmentUrl),
        commentUrl: hyperlink(comment.commentUrl ? 'Open comment' : '', comment.commentUrl),
      });
    }
  }
  setupSheet(attachmentsSheet);

  const summarySheet = workbook.addWorksheet('Post Summary');
  summarySheet.columns = [
    { header: 'Field', key: 'field', width: 30 },
    { header: 'Value', key: 'value', width: 90 },
  ];
  const summaryRows: Array<[string, CellValue]> = [
    ['Platform', bundle.job.target.platform ?? (bundle.job.target.canonicalUrl.includes('linkedin.com') ? 'linkedin' : 'facebook')],
    ['Canonical URL', hyperlink(bundle.job.target.canonicalUrl, bundle.job.target.canonicalUrl)],
    ['Original URL', safeSpreadsheetText(bundle.job.target.originalUrl)],
    ['Post type', bundle.job.target.type],
    ['Post ID', bundle.job.target.postId ?? ''],
    ['Group ID', bundle.job.target.groupId ?? ''],
    ['Collection mode', bundle.job.mode],
    ['Collection status', bundle.job.status],
    ['Partial export', bundle.job.isPartial ? 'Yes' : 'No'],
    ['Completion reason', safeSpreadsheetText(bundle.job.completionReason)],
    ['Created at', new Date(bundle.job.createdAt)],
    ['Started at', bundle.job.startedAt ? new Date(bundle.job.startedAt) : ''],
    ['Completed at', bundle.job.completedAt ? new Date(bundle.job.completedAt) : ''],
    ['Unique rows', bundle.job.counters.uniqueTotal],
    ['Top-level comments', bundle.job.counters.topLevel],
    ['Replies', bundle.job.counters.replies],
    ['Duplicates ignored', bundle.job.counters.duplicates],
    ['Failed controls', bundle.job.counters.failedControls],
    ['Configured row limit', bundle.job.rowLimit],
    ['Page title', safeSpreadsheetText(bundle.job.metadata?.pageTitle)],
    ['Post author', safeSpreadsheetText(bundle.job.metadata?.postAuthor)],
    ['Displayed comment count', bundle.job.metadata?.displayedCommentCount ?? ''],
    ['Comment sorting', bundle.job.metadata?.currentSort ?? ''],
    ['Platform interface language', bundle.job.metadata?.interfaceLanguage ?? ''],
    ['Document direction', bundle.job.metadata?.documentDirection ?? ''],
    ['Browser timezone', bundle.job.metadata?.timezone ?? ''],
  ];
  summarySheet.addRows(summaryRows.map(([field, value]) => ({ field, value })));
  summarySheet.getColumn('value').alignment = { wrapText: true, vertical: 'top' };
  summarySheet.getColumn('value').numFmt = 'yyyy-mm-dd hh:mm:ss';
  setupSheet(summarySheet);

  const logSheet = workbook.addWorksheet('Run Log');
  logSheet.columns = [
    { header: 'Timestamp', key: 'timestamp', width: 25 },
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Code', key: 'code', width: 24 },
    { header: 'Message', key: 'message', width: 90 },
    { header: 'Count', key: 'count', width: 12 },
  ];
  for (const log of bundle.logs) {
    logSheet.addRow({
      timestamp: new Date(log.timestamp),
      severity: log.severity,
      code: log.code,
      message: safeSpreadsheetText(log.message),
      count: log.count ?? '',
    });
  }
  logSheet.getColumn('timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';
  setupSheet(logSheet);

  const buffer = await workbook.xlsx.writeBuffer({
    useStyles: true,
    useSharedStrings: true,
  });
  return buffer;
}

export function workbookFilename(bundle: JobBundle): string {
  const id = bundle.job.target.postId?.replace(/[^a-zA-Z0-9_-]/g, '') || 'post';
  const timestamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .replace(/\.\d{3}Z$/, 'Z');
  const platform = bundle.job.target.platform ??
    (bundle.job.target.canonicalUrl.includes('linkedin.com') ? 'linkedin' : 'facebook');
  return `${platform}-comments_${bundle.job.target.type}_${id}_${timestamp}.xlsx`;
}
