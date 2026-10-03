import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { commentFingerprint } from './collector/dom';
import type {
  CollectionJob,
  CommentRecord,
  JobBundle,
  JobLog,
  StoredComment,
} from './types';

interface CommentsDatabase extends DBSchema {
  jobs: {
    key: string;
    value: CollectionJob;
    indexes: {
      'by-updated': string;
      'by-tab': number;
    };
  };
  comments: {
    key: string;
    value: StoredComment;
    indexes: {
      'by-job': string;
    };
  };
  logs: {
    key: number;
    value: JobLog;
    indexes: {
      'by-job': string;
    };
  };
}

const DATABASE_NAME = 'facebook-comments-to-excel';
let databasePromise: Promise<IDBPDatabase<CommentsDatabase>> | undefined;

function database(): Promise<IDBPDatabase<CommentsDatabase>> {
  databasePromise ??= openDB<CommentsDatabase>(DATABASE_NAME, 1, {
    upgrade(db) {
      const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
      jobs.createIndex('by-updated', 'updatedAt');
      jobs.createIndex('by-tab', 'tabId');

      const comments = db.createObjectStore('comments', { keyPath: 'key' });
      comments.createIndex('by-job', 'jobId');

      const logs = db.createObjectStore('logs', {
        keyPath: 'id',
        autoIncrement: true,
      });
      logs.createIndex('by-job', 'jobId');
    },
  });
  return databasePromise;
}

export async function putJob(job: CollectionJob): Promise<void> {
  const db = await database();
  await db.put('jobs', job);
}

export async function getJob(jobId: string): Promise<CollectionJob | undefined> {
  const db = await database();
  return db.get('jobs', jobId);
}

export async function listJobs(): Promise<CollectionJob[]> {
  const db = await database();
  const jobs = await db.getAll('jobs');
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateJob(
  jobId: string,
  updater: (job: CollectionJob) => CollectionJob,
): Promise<CollectionJob | undefined> {
  const db = await database();
  const tx = db.transaction('jobs', 'readwrite');
  const job = await tx.store.get(jobId);
  if (!job) {
    await tx.done;
    return undefined;
  }
  const updated = updater(job);
  updated.updatedAt = new Date().toISOString();
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export async function upsertComments(
  jobId: string,
  comments: CommentRecord[],
): Promise<{
  added: number;
  addedTopLevel: number;
  addedReplies: number;
  updated: number;
  duplicates: number;
}> {
  const db = await database();
  const tx = db.transaction('comments', 'readwrite');
  let added = 0;
  let addedTopLevel = 0;
  let addedReplies = 0;
  let updated = 0;
  let duplicates = 0;
  const now = new Date().toISOString();

  for (const comment of comments) {
    const key = `${jobId}::${comment.id}`;
    const fingerprint = commentFingerprint(comment);
    const existing = await tx.store.get(key);
    if (!existing) {
      added += 1;
      if (comment.parentId) addedReplies += 1;
      else addedTopLevel += 1;
    }
    else if (existing.fingerprint !== fingerprint) updated += 1;
    else duplicates += 1;

    if (!existing || existing.fingerprint !== fingerprint) {
      await tx.store.put({
        ...comment,
        key,
        jobId,
        fingerprint,
        updatedAt: now,
      });
    }
  }
  await tx.done;
  return { added, addedTopLevel, addedReplies, updated, duplicates };
}

export async function getComments(jobId: string): Promise<StoredComment[]> {
  const db = await database();
  const comments = await db.getAllFromIndex('comments', 'by-job', jobId);
  return comments.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export async function addLog(log: JobLog): Promise<void> {
  const db = await database();
  await db.add('logs', log);
}

export async function getLogs(jobId: string): Promise<JobLog[]> {
  const db = await database();
  const logs = await db.getAllFromIndex('logs', 'by-job', jobId);
  return logs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getJobBundle(jobId: string): Promise<JobBundle | undefined> {
  const [job, comments, logs] = await Promise.all([
    getJob(jobId),
    getComments(jobId),
    getLogs(jobId),
  ]);
  return job ? { job, comments, logs } : undefined;
}

export async function clearJob(jobId: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(['jobs', 'comments', 'logs'], 'readwrite');
  const commentKeys = await tx.objectStore('comments').index('by-job').getAllKeys(jobId);
  const logKeys = await tx.objectStore('logs').index('by-job').getAllKeys(jobId);
  await Promise.all([
    tx.objectStore('jobs').delete(jobId),
    ...commentKeys.map((key) => tx.objectStore('comments').delete(key)),
    ...logKeys.map((key) => tx.objectStore('logs').delete(key)),
  ]);
  await tx.done;
}

export async function clearAllDataForTests(): Promise<void> {
  const db = await database();
  const tx = db.transaction(['jobs', 'comments', 'logs'], 'readwrite');
  await Promise.all([
    tx.objectStore('jobs').clear(),
    tx.objectStore('comments').clear(),
    tx.objectStore('logs').clear(),
  ]);
  await tx.done;
}
