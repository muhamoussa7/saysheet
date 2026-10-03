export type PostType =
  | 'group'
  | 'page'
  | 'profile'
  | 'photo'
  | 'video'
  | 'reel'
  | 'linkedin-post'
  | 'unknown';

export type Platform = 'facebook' | 'linkedin';

export type CollectionMode = 'manual' | 'assisted';

export type JobStatus =
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'exporting';

export interface PostTarget {
  platform: Platform;
  canonicalUrl: string;
  originalUrl: string;
  type: PostType;
  postId?: string;
  groupId?: string;
  ownerId?: string;
}

export interface PostMetadata {
  pageTitle: string;
  postAuthor?: string;
  containerName?: string;
  displayedCommentCount?: number;
  currentSort?: string;
  interfaceLanguage: string;
  documentDirection: string;
  timezone: string;
}

export interface CommentRecord {
  id: string;
  parentId?: string;
  depth: number;
  type: 'comment' | 'reply';
  sequence: number;
  authorName: string;
  authorProfileUrl?: string;
  text: string;
  publishedAtDisplay?: string;
  publishedAtIso?: string;
  edited: boolean;
  reactionCount?: number;
  replyCountDisplayed?: number;
  commentUrl?: string;
  attachmentTypes: Array<'photo' | 'video' | 'link'>;
  attachmentUrls: string[];
  postType: PostType;
  parseWarnings: string[];
}

export interface StoredComment extends CommentRecord {
  key: string;
  jobId: string;
  fingerprint: string;
  updatedAt: string;
}

export interface JobCounters {
  uniqueTotal: number;
  topLevel: number;
  replies: number;
  duplicates: number;
  failedControls: number;
}

export interface CollectionJob {
  id: string;
  target: PostTarget;
  mode: CollectionMode;
  status: JobStatus;
  tabId: number;
  rowLimit: number;
  action: string;
  completionReason?: string;
  isPartial: boolean;
  metadata?: PostMetadata;
  counters: JobCounters;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  lastError?: string;
}

export type LogSeverity = 'info' | 'warning' | 'error';

export interface JobLog {
  id?: number;
  jobId: string;
  timestamp: string;
  severity: LogSeverity;
  code: string;
  message: string;
  count?: number;
}

export interface JobBundle {
  job: CollectionJob;
  comments: StoredComment[];
  logs: JobLog[];
}

export type JobCommand = 'pause' | 'resume' | 'rescan' | 'stop' | 'finish';

export interface CreateJobRequest {
  type: 'job:create';
  target: PostTarget;
  mode: CollectionMode;
  rowLimit: number;
  tabId: number;
  navigate: boolean;
}

export type RuntimeRequest =
  | CreateJobRequest
  | { type: 'job:get'; jobId: string }
  | { type: 'job:list' }
  | { type: 'job:command'; jobId: string; command: JobCommand }
  | { type: 'job:clear'; jobId: string }
  | {
      type: 'collector:batch';
      jobId: string;
      comments: CommentRecord[];
    }
  | {
      type: 'collector:metadata';
      jobId: string;
      metadata: PostMetadata;
    }
  | {
      type: 'collector:status';
      jobId: string;
      status: JobStatus;
      action: string;
      completionReason?: string;
      isPartial?: boolean;
      error?: string;
    }
  | {
      type: 'collector:log';
      jobId: string;
      severity: LogSeverity;
      code: string;
      message: string;
      count?: number;
    }
  | { type: 'download:register'; jobId: string; downloadId: number };

export type CollectorRequest =
  | {
      type: 'collector:start';
      jobId: string;
      target: PostTarget;
      mode: CollectionMode;
      rowLimit: number;
    }
  | { type: 'collector:command'; command: JobCommand };

export interface RuntimeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
