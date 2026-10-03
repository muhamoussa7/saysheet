import { browser } from 'wxt/browser';
import {
  addLog,
  clearJob,
  getJob,
  listJobs,
  putJob,
  updateJob,
  upsertComments,
} from '../lib/db';
import { errorMessage } from '../lib/runtime';
import type {
  CollectionJob,
  CollectorRequest,
  CreateJobRequest,
  JobCommand,
  RuntimeRequest,
  RuntimeResult,
} from '../lib/types';

const DOWNLOAD_MAP_KEY = 'facebook-comments-download-map';
const COLLECTOR_FILES = {
  facebook: '/content-scripts/facebook-collector.js',
  linkedin: '/content-scripts/linkedin-collector.js',
} as const;

function platformForJob(job: CollectionJob): 'facebook' | 'linkedin' {
  return job.target.platform ?? (job.target.canonicalUrl.includes('linkedin.com') ? 'linkedin' : 'facebook');
}

function platformName(job: CollectionJob): string {
  return platformForJob(job) === 'linkedin' ? 'LinkedIn' : 'Facebook';
}

function result<T>(data: T): RuntimeResult<T> {
  return { ok: true, data };
}

function failure<T = unknown>(error: unknown): RuntimeResult<T> {
  return { ok: false, error: errorMessage(error) };
}

function now(): string {
  return new Date().toISOString();
}

function createJob(request: CreateJobRequest): CollectionJob {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    target: request.target,
    mode: request.mode,
    status: 'ready',
    tabId: request.tabId,
    rowLimit: Math.min(50_000, Math.max(100, request.rowLimit)),
    action: request.navigate
      ? `Opening the ${request.target.platform === 'linkedin' ? 'LinkedIn' : 'Facebook'} post…`
      : 'Preparing the collector…',
    isPartial: false,
    counters: {
      uniqueTotal: 0,
      topLevel: 0,
      replies: 0,
      duplicates: 0,
      failedControls: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function waitForTabReady(tabId: number, expectedUrl: string): Promise<void> {
  const current = await browser.tabs.get(tabId);
  const expectedHost = new URL(expectedUrl).hostname;
  if (
    current.status === 'complete' &&
    current.url &&
    new URL(current.url).hostname === expectedHost
  ) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      reject(new Error('The post took too long to open. Reopen the extension and try again.'));
    }, 90_000);
    const listener = (
      changedTabId: number,
      changeInfo: { status?: string; url?: string },
      tab: { url?: string },
    ) => {
      if (changedTabId !== tabId || changeInfo.status !== 'complete') return;
      const url = changeInfo.url ?? tab.url ?? '';
      try {
        if (new URL(url).hostname !== expectedHost) return;
      } catch {
        return;
      }
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    browser.tabs.onUpdated.addListener(listener);
  });
}

async function injectAndStart(job: CollectionJob): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId: job.tabId },
    files: [COLLECTOR_FILES[platformForJob(job)]],
  });
  const message: CollectorRequest = {
    type: 'collector:start',
    jobId: job.id,
    target: job.target,
    mode: job.mode,
    rowLimit: job.rowLimit,
  };
  await browser.tabs.sendMessage(job.tabId, message);
}

async function prepareAndStart(job: CollectionJob, navigate: boolean): Promise<void> {
  try {
    if (navigate) {
      await browser.tabs.update(job.tabId, { url: job.target.canonicalUrl, active: true });
      await waitForTabReady(job.tabId, job.target.canonicalUrl);
    }
    await injectAndStart(job);
  } catch (error) {
    const message = errorMessage(error);
    await updateJob(job.id, (current) => ({
      ...current,
      status: 'error',
      action: 'Could not start the collector.',
      isPartial: current.counters.uniqueTotal > 0,
      lastError: message,
      completedAt: now(),
    }));
    await addLog({
      jobId: job.id,
      timestamp: now(),
      severity: 'error',
      code: 'COLLECTOR_START_FAILED',
      message,
    });
  }
}

async function handleCreate(request: CreateJobRequest): Promise<RuntimeResult<CollectionJob>> {
  const job = createJob(request);
  await putJob(job);
  await addLog({
    jobId: job.id,
    timestamp: now(),
    severity: 'info',
    code: 'JOB_CREATED',
    message: `Created a ${job.mode} ${platformName(job)} collection job for ${job.target.canonicalUrl}`,
  });

  await browser.tabs.create({
    url: browser.runtime.getURL(`/dashboard.html?job=${encodeURIComponent(job.id)}`),
    active: false,
  });
  await prepareAndStart(job, request.navigate);
  return result((await getJob(job.id)) ?? job);
}

async function sendCollectorCommand(
  job: CollectionJob,
  command: JobCommand,
): Promise<void> {
  const message: CollectorRequest = { type: 'collector:command', command };
  try {
    await browser.tabs.sendMessage(job.tabId, message);
  } catch (error) {
    if (!['resume', 'rescan'].includes(command)) throw error;
    await injectAndStart(job);
  }
}

async function handleCommand(
  jobId: string,
  command: JobCommand,
): Promise<RuntimeResult<CollectionJob>> {
  const job = await getJob(jobId);
  if (!job) return failure('Collection job not found.');

  if (command === 'finish') {
    await sendCollectorCommand(job, command).catch(() => undefined);
    const updated = await updateJob(jobId, (current) => ({
      ...current,
      status: 'completed',
      action: 'Collection finished by the user.',
      completionReason: 'Finished manually by the user.',
      isPartial: current.isPartial || current.mode === 'manual',
      completedAt: now(),
    }));
    return result(updated ?? job);
  }

  await sendCollectorCommand(job, command);
  return result((await getJob(jobId)) ?? job);
}

async function readDownloadMap(): Promise<Record<string, string>> {
  const stored = await browser.storage.local.get(DOWNLOAD_MAP_KEY);
  const value = stored[DOWNLOAD_MAP_KEY];
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

async function writeDownloadMap(map: Record<string, string>): Promise<void> {
  await browser.storage.local.set({ [DOWNLOAD_MAP_KEY]: map });
}

async function registerDownload(jobId: string, downloadId: number): Promise<void> {
  const map = await readDownloadMap();
  map[String(downloadId)] = jobId;
  await writeDownloadMap(map);
  await updateJob(jobId, (job) => ({
    ...job,
    status: 'exporting',
    action: 'Saving the Excel workbook…',
  }));

  const matches = await browser.downloads.search({ id: downloadId });
  const current = matches[0];
  if (current?.state === 'complete') await finishDownload(downloadId, jobId);
  else if (current?.state === 'interrupted') await interruptDownload(downloadId, jobId);
}

async function finishDownload(downloadId: number, jobId: string): Promise<void> {
  await clearJob(jobId);
  const map = await readDownloadMap();
  delete map[String(downloadId)];
  await writeDownloadMap(map);
}

async function interruptDownload(downloadId: number, jobId: string): Promise<void> {
  await updateJob(jobId, (job) => ({
    ...job,
    status: 'completed',
    action: 'The download was interrupted. Your local job was kept so you can retry.',
    lastError: 'Excel download interrupted.',
  }));
  await addLog({
    jobId,
    timestamp: now(),
    severity: 'warning',
    code: 'DOWNLOAD_INTERRUPTED',
    message: 'Chrome reported that the Excel download was interrupted. The job was retained.',
  });
  const map = await readDownloadMap();
  delete map[String(downloadId)];
  await writeDownloadMap(map);
}

async function handleRuntimeMessage(
  request: RuntimeRequest,
  sender: { tab?: { id?: number } },
): Promise<RuntimeResult> {
  try {
    switch (request.type) {
      case 'job:create':
        return await handleCreate(request);
      case 'job:get':
        return result(await getJob(request.jobId));
      case 'job:list':
        return result(await listJobs());
      case 'job:command':
        return await handleCommand(request.jobId, request.command);
      case 'job:clear':
        await clearJob(request.jobId);
        return result(undefined);
      case 'collector:metadata': {
        const job = await getJob(request.jobId);
        if (!job || (sender.tab?.id && sender.tab.id !== job.tabId)) {
          return failure('Collector message did not match its job tab.');
        }
        const updated = await updateJob(request.jobId, (current) => ({
          ...current,
          metadata: request.metadata,
        }));
        return result(updated);
      }
      case 'collector:batch': {
        const job = await getJob(request.jobId);
        if (!job || (sender.tab?.id && sender.tab.id !== job.tabId)) {
          return failure('Collector batch did not match its job tab.');
        }
        const changes = await upsertComments(request.jobId, request.comments);
        const updated = await updateJob(request.jobId, (current) => ({
          ...current,
          counters: {
            ...current.counters,
            uniqueTotal: current.counters.uniqueTotal + changes.added,
            topLevel: current.counters.topLevel + changes.addedTopLevel,
            replies: current.counters.replies + changes.addedReplies,
            duplicates: current.counters.duplicates + changes.duplicates,
          },
        }));
        return result({ changes, job: updated });
      }
      case 'collector:status': {
        const updated = await updateJob(request.jobId, (current) => ({
          ...current,
          status: request.status,
          action: request.action,
          completionReason: request.completionReason ?? current.completionReason,
          isPartial: request.isPartial ?? current.isPartial,
          lastError: request.error ?? current.lastError,
          startedAt:
            request.status === 'running' && !current.startedAt ? now() : current.startedAt,
          completedAt: ['completed', 'stopped', 'error'].includes(request.status)
            ? now()
            : current.completedAt,
        }));
        return result(updated);
      }
      case 'collector:log': {
        await addLog({
          jobId: request.jobId,
          timestamp: now(),
          severity: request.severity,
          code: request.code,
          message: request.message,
          count: request.count,
        });
        if (request.code === 'CONTROL_FAILED') {
          await updateJob(request.jobId, (job) => ({
            ...job,
            counters: {
              ...job.counters,
              failedControls: job.counters.failedControls + (request.count ?? 1),
            },
          }));
        }
        return result(undefined);
      }
      case 'download:register':
        await registerDownload(request.jobId, request.downloadId);
        return result(undefined);
      default:
        return failure('Unknown extension message.');
    }
  } catch (error) {
    return failure(error);
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender) =>
    handleRuntimeMessage(message as RuntimeRequest, sender),
  );

  browser.downloads.onChanged.addListener((delta) => {
    if (!delta.state?.current || !['complete', 'interrupted'].includes(delta.state.current)) return;
    void readDownloadMap().then((map) => {
      const jobId = map[String(delta.id)];
      if (!jobId) return;
      if (delta.state?.current === 'complete') void finishDownload(delta.id, jobId);
      else void interruptDownload(delta.id, jobId);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void listJobs().then(async (jobs) => {
      for (const job of jobs.filter(
        (candidate) => candidate.tabId === tabId && ['ready', 'running'].includes(candidate.status),
      )) {
        await updateJob(job.id, (current) => ({
          ...current,
          status: 'paused',
          action: `The ${platformName(job)} tab was closed. Reopen the post to resume.`,
          isPartial: current.counters.uniqueTotal > 0,
        }));
        await addLog({
          jobId: job.id,
          timestamp: now(),
          severity: 'warning',
          code: 'SOURCE_TAB_CLOSED',
          message: `The ${platformName(job)} source tab was closed during collection.`,
        });
      }
    });
  });
});
