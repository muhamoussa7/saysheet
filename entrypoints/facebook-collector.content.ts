import { browser } from 'wxt/browser';
import {
  commentFingerprint,
  detectBlockingState,
  extractComments,
  extractPostMetadata,
  findAllCommentsOption,
  findCommentScroller,
  findCurrentSort,
  findExpandActions,
  findPostRoot,
  getCurrentSort,
  type PostRoot,
} from '../lib/collector/dom';
import type {
  CollectionMode,
  CollectionJob,
  CollectorRequest,
  JobCommand,
  JobStatus,
  PostTarget,
  RuntimeResult,
} from '../lib/types';

declare global {
  interface Window {
    __facebookCommentsCollectorInstalled?: boolean;
  }
}

interface CollectorState {
  jobId: string;
  target: PostTarget;
  mode: CollectionMode;
  rowLimit: number;
  paused: boolean;
  stopped: boolean;
  running: boolean;
  fingerprints: Map<string, string>;
  failedActions: Set<string>;
  actionAttempts: Map<string, number>;
  uniqueTotal: number;
  displayedCommentCount?: number;
  lastProgressAt: number;
}

interface ScrollAttempt {
  found: boolean;
  moved: boolean;
  mutated: boolean;
  atEnd: boolean;
  percent?: number;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const SORT_MENU_TIMEOUT_MS = 20_000;
const SORT_CONFIRM_TIMEOUT_MS = 30_000;
const CONTROL_LOAD_TIMEOUT_MS = 45_000;
const MAX_CONTROL_ATTEMPTS = 2;
const BOTTOM_MUTATION_WAIT_MS = 8_000;
const COMPLETION_QUIET_MS = 60_000;
const COUNT_MISMATCH_QUIET_MS = 120_000;

async function waitForValue<T>(
  read: () => T | undefined,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = read();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return undefined;
}

async function send<T>(message: unknown): Promise<T | undefined> {
  try {
    const response = (await browser.runtime.sendMessage(message)) as RuntimeResult<T>;
    return response.ok ? response.data : undefined;
  } catch {
    return undefined;
  }
}

async function sendStatus(
  state: CollectorState,
  status: JobStatus,
  action: string,
  extras: {
    completionReason?: string;
    isPartial?: boolean;
    error?: string;
  } = {},
): Promise<void> {
  await send({
    type: 'collector:status',
    jobId: state.jobId,
    status,
    action,
    ...extras,
  });
}

async function sendLog(
  state: CollectorState,
  severity: 'info' | 'warning' | 'error',
  code: string,
  message: string,
  count?: number,
): Promise<void> {
  await send({
    type: 'collector:log',
    jobId: state.jobId,
    severity,
    code,
    message,
    count,
  });
}

function waitForMutation(root: PostRoot, timeoutMs = 8_000): {
  promise: Promise<boolean>;
  cancel: () => void;
} {
  let observer: MutationObserver | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const promise = new Promise<boolean>((resolve) => {
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timeout) clearTimeout(timeout);
      resolve(changed);
    };
    observer = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) =>
            mutation.type === 'characterData' ||
            mutation.type === 'attributes' ||
            mutation.addedNodes.length > 0 ||
            mutation.removedNodes.length > 0,
        )
      ) {
        finish(true);
      }
    });
    observer.observe(root instanceof Document ? root.documentElement : root, {
      attributes: true,
      attributeFilter: ['aria-busy', 'aria-expanded', 'aria-label'],
      childList: true,
      characterData: true,
      subtree: true,
    });
    timeout = setTimeout(() => finish(false), timeoutMs);
  });

  return {
    promise,
    cancel: () => {
      observer?.disconnect();
      if (timeout) clearTimeout(timeout);
    },
  };
}

class Collector {
  private state?: CollectorState;

  start(
    jobId: string,
    target: PostTarget,
    mode: CollectionMode,
    rowLimit: number,
  ): void {
    if (this.state?.jobId === jobId && this.state.running) return;
    this.state = {
      jobId,
      target,
      mode,
      rowLimit,
      paused: false,
      stopped: false,
      running: false,
      fingerprints: new Map(),
      failedActions: new Set(),
      actionAttempts: new Map(),
      uniqueTotal: 0,
      lastProgressAt: Date.now(),
    };
    void this.run();
  }

  command(command: JobCommand): void {
    const state = this.state;
    if (!state) return;
    if (command === 'pause') {
      state.paused = true;
      void sendStatus(state, 'paused', 'Collection paused.');
      return;
    }
    if (command === 'stop' || command === 'finish') {
      state.stopped = true;
      state.paused = false;
      if (command === 'stop') {
        void sendStatus(state, 'stopped', 'Collection stopped. Partial export is available.', {
          completionReason: 'Stopped by the user.',
          isPartial: true,
        });
      }
      return;
    }
    if (command === 'resume') {
      state.failedActions.clear();
      state.actionAttempts.clear();
      state.lastProgressAt = Date.now();
    }
    state.paused = false;
    if (!state.running) void this.run();
  }

  private root(): PostRoot | null {
    const state = this.state;
    return state ? findPostRoot(document, state.target) : null;
  }

  private async scan(root: PostRoot): Promise<number> {
    const state = this.state;
    if (!state) return 0;
    const metadata = extractPostMetadata(root);
    if (metadata.displayedCommentCount !== undefined) {
      state.displayedCommentCount = metadata.displayedCommentCount;
    }
    await send({ type: 'collector:metadata', jobId: state.jobId, metadata });

    const comments = extractComments(root, state.target);
    const changed = comments.filter((comment) => {
      const fingerprint = commentFingerprint(comment);
      if (state.fingerprints.get(comment.id) === fingerprint) return false;
      state.fingerprints.set(comment.id, fingerprint);
      return true;
    });

    for (let index = 0; index < changed.length; index += 100) {
      const batch = changed.slice(index, index + 100);
      const response = await send<{
        job?: CollectionJob;
      }>({
        type: 'collector:batch',
        jobId: state.jobId,
        comments: batch,
      });
      if (response?.job) state.uniqueTotal = response.job.counters.uniqueTotal;
    }
    if (changed.length > 0) state.lastProgressAt = Date.now();
    return changed.length;
  }

  private async ensureAllComments(root: PostRoot): Promise<boolean> {
    const state = this.state;
    if (!state || state.mode !== 'assisted') return true;
    let sawSortControl = false;
    let sawAllCommentsOption = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const currentRoot = this.root() ?? root;
      if (getCurrentSort(currentRoot) === 'All comments') return true;

      const sortControl = findCurrentSort(currentRoot) ?? await waitForValue(
        () => {
          const latestRoot = this.root();
          return latestRoot ? findCurrentSort(latestRoot) : undefined;
        },
        SORT_MENU_TIMEOUT_MS,
      );
      if (!sortControl) break;
      sawSortControl = true;
      const latestRoot = this.root();
      if (latestRoot && getCurrentSort(latestRoot) === 'All comments') return true;

      let allComments = findAllCommentsOption(document);
      if (!allComments) {
        sortControl.scrollIntoView({ block: 'center', behavior: 'auto' });
        sortControl.click();
        allComments = await waitForValue(
          () => findAllCommentsOption(document),
          SORT_MENU_TIMEOUT_MS,
        );
      }
      if (!allComments) continue;
      sawAllCommentsOption = true;

      allComments.scrollIntoView({ block: 'center', behavior: 'auto' });
      allComments.click();
      const confirmed = await waitForValue(
        () => {
          const latestRoot = this.root();
          return latestRoot && getCurrentSort(latestRoot) === 'All comments'
            ? true
            : undefined;
        },
        SORT_CONFIRM_TIMEOUT_MS,
      );
      if (confirmed) {
        state.lastProgressAt = Date.now();
        await sleep(1_000);
        return true;
      }
    }

    const code = !sawSortControl
      ? 'SORT_CONTROL_NOT_FOUND'
      : !sawAllCommentsOption
        ? 'ALL_COMMENTS_OPTION_NOT_FOUND'
        : 'SORT_CHANGE_NOT_CONFIRMED';
    await sendLog(
      state,
      'warning',
      code,
      'Facebook did not confirm “All comments” after two attempts. Select it manually, then resume.',
    );
    return false;
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.state?.paused && !this.state.stopped) await sleep(300);
  }

  private async advanceCommentScroller(root: PostRoot): Promise<ScrollAttempt> {
    const scroller = findCommentScroller(root);
    if (!scroller) {
      return { found: false, moved: false, mutated: false, atEnd: true };
    }

    const beforeTop = scroller.scrollTop;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Math.max(scroller.clientHeight * 6, 2_000);
    const nextTop = Math.min(maxScrollTop, beforeTop + step);
    const nearEnd = maxScrollTop - nextTop <= 48;
    const watcher = waitForMutation(root, nearEnd ? BOTTOM_MUTATION_WAIT_MS : 1_200);

    try {
      scroller.scrollTo({ top: nextTop, behavior: 'auto' });
    } catch {
      scroller.scrollTop = nextTop;
    }
    if (Math.abs(scroller.scrollTop - nextTop) > 2) scroller.scrollTop = nextTop;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    const moved = scroller.scrollTop > beforeTop + 2;
    const mutated = await watcher.promise;
    const currentScroller = findCommentScroller(root) ?? scroller;
    const currentMax = Math.max(
      0,
      currentScroller.scrollHeight - currentScroller.clientHeight,
    );
    const atEnd = currentMax - currentScroller.scrollTop <= 48;
    const percent = currentMax > 0
      ? Math.min(100, Math.round((currentScroller.scrollTop / currentMax) * 100))
      : 100;

    return { found: true, moved, mutated, atEnd, percent };
  }

  private async runManual(root: PostRoot): Promise<void> {
    const state = this.state;
    if (!state) return;
    const changed = await this.scan(root);
    await sendStatus(
      state,
      'paused',
      changed
        ? `Scanned ${changed} new or changed visible comments. Load more on Facebook, then scan again.`
        : 'No new visible comments found. Load more on Facebook or finish the collection.',
    );
  }

  private async runAssisted(initialRoot: PostRoot): Promise<void> {
    const state = this.state;
    if (!state) return;
    const allCommentsReady = await this.ensureAllComments(initialRoot);
    if (!allCommentsReady) {
      state.paused = true;
      await sendStatus(
        state,
        'paused',
        'Select “All comments” on Facebook, then resume the collection.',
        { isPartial: state.uniqueTotal > 0 },
      );
      return;
    }

    let bottomQuietSince: number | undefined;
    while (!state.stopped) {
      await this.waitWhilePaused();
      if (state.stopped) return;

      const blocking = detectBlockingState(document);
      if (blocking) {
        state.paused = true;
        await sendLog(state, 'warning', 'FACEBOOK_BLOCKING_STATE', blocking);
        await sendStatus(state, 'paused', `${blocking} Resolve it manually, then resume.`, {
          isPartial: state.uniqueTotal > 0,
        });
        return;
      }

      const root = this.root();
      if (!root) throw new Error('The Facebook post container is no longer available.');
      const changed = await this.scan(root);
      if (changed > 0) bottomQuietSince = undefined;
      if (state.uniqueTotal >= state.rowLimit) {
        await sendLog(
          state,
          'warning',
          'ROW_LIMIT_REACHED',
          `Collection stopped at the configured ${state.rowLimit.toLocaleString()} row limit.`,
        );
        await sendStatus(state, 'completed', 'The configured row limit was reached.', {
          completionReason: `Stopped at the ${state.rowLimit.toLocaleString()} row safety limit.`,
          isPartial: true,
        });
        return;
      }

      const actions = findExpandActions(root, state.target).filter(
        (action) => !state.failedActions.has(action.key),
      );
      const action = actions[0];
      if (!action) {
        const scroll = await this.advanceCommentScroller(root);
        if (scroll.moved || !scroll.atEnd) {
          bottomQuietSince = undefined;
          await sendStatus(
            state,
            'running',
            scroll.found
              ? `Scrolling through Facebook comments${scroll.percent === undefined ? '' : ` (${scroll.percent}%)`}…`
              : 'Waiting for Facebook to render more comments…',
          );
          continue;
        }

        if (scroll.mutated) {
          await sendStatus(state, 'running', 'Facebook changed the comments panel; scanning it again…');
          await sleep(300);
          continue;
        }

        if (document.visibilityState === 'hidden') {
          bottomQuietSince = undefined;
          await sendStatus(
            state,
            'running',
            'At the bottom. Keep the Facebook post tab visible so delayed comments can finish loading…',
          );
          await sleep(5_000);
          continue;
        }

        const now = Date.now();
        bottomQuietSince ??= now;
        const displayedCountMissing = Boolean(
          state.displayedCommentCount &&
          state.uniqueTotal < state.displayedCommentCount,
        );
        const requiredQuietMs = displayedCountMissing
          ? COUNT_MISMATCH_QUIET_MS
          : COMPLETION_QUIET_MS;
        const quietSince = Math.max(bottomQuietSince, state.lastProgressAt);
        const quietForMs = now - quietSince;

        if (quietForMs >= requiredQuietMs) {
          const isPartial = displayedCountMissing || state.failedActions.size > 0;
          if (displayedCountMissing) {
            await sendLog(
              state,
              'warning',
              'DISPLAY_COUNT_MISMATCH',
              `Facebook displays ${state.displayedCommentCount?.toLocaleString()} comments, but only ${state.uniqueTotal.toLocaleString()} unique accessible comments and replies were found after reaching the bottom.`,
            );
          }
          if (isPartial) {
            state.paused = true;
            await sendStatus(
              state,
              'paused',
              'Facebook still indicates missing items or an unresolved loader. Resume to retry, or finish to export the partial result.',
              {
                completionReason: 'Automatic completeness verification is unresolved after the extended slow-network wait.',
                isPartial: true,
              },
            );
          } else {
            await sendStatus(
              state,
              'completed',
              'All available comments and replies were collected.',
              {
                completionReason: `The comments panel stayed at the bottom without new IDs or loaders for ${Math.round(requiredQuietMs / 1_000)} seconds.`,
                isPartial: false,
              },
            );
          }
          return;
        }
        const secondsRemaining = Math.max(1, Math.ceil((requiredQuietMs - quietForMs) / 1_000));
        await sendStatus(
          state,
          'running',
          `At the bottom; waiting ${secondsRemaining}s for delayed comments and replies…`,
        );
        await sleep(Math.min(5_000, requiredQuietMs - quietForMs));
        continue;
      }

      bottomQuietSince = undefined;
      await sendStatus(
        state,
        'running',
        action.kind === 'text'
          ? 'Expanding a truncated comment…'
          : action.kind === 'replies'
            ? `Loading replies: ${action.label}`
            : `Loading more comments: ${action.label}`,
      );

      action.element.scrollIntoView({ block: 'center', behavior: 'auto' });
      const watcher = waitForMutation(root, CONTROL_LOAD_TIMEOUT_MS);
      action.element.click();
      const mutated = await watcher.promise;
      if (!mutated) {
        const attempts = (state.actionAttempts.get(action.key) ?? 0) + 1;
        state.actionAttempts.set(action.key, attempts);
        if (attempts < MAX_CONTROL_ATTEMPTS) {
          await sendLog(
            state,
            'info',
            'CONTROL_RETRY',
            `“${action.label}” did not load within ${CONTROL_LOAD_TIMEOUT_MS / 1_000} seconds. Retrying once.`,
          );
          await sleep(1_500);
        } else {
          state.failedActions.add(action.key);
          await sendLog(
            state,
            'warning',
            'CONTROL_FAILED',
            `Facebook did not respond to “${action.label}” after ${MAX_CONTROL_ATTEMPTS} attempts. The result will be marked partial.`,
            1,
          );
        }
      } else {
        state.actionAttempts.delete(action.key);
        state.lastProgressAt = Date.now();
        await sleep(750);
      }
    }
  }

  private async run(): Promise<void> {
    const state = this.state;
    if (!state || state.running || state.stopped) return;
    state.running = true;
    try {
      await sendStatus(state, 'running', 'Locating the Facebook post…');
      const root = this.root();
      if (!root) throw new Error('No supported Facebook post was found on this page.');
      if (state.mode === 'manual') await this.runManual(root);
      else await this.runAssisted(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendLog(state, 'error', 'COLLECTION_FAILED', message);
      await sendStatus(state, 'error', 'Collection failed. A partial export may still be available.', {
        error: message,
        isPartial: state.uniqueTotal > 0,
      });
    } finally {
      state.running = false;
    }
  }
}

export default defineContentScript({
  registration: 'runtime',
  main() {
    if (window.__facebookCommentsCollectorInstalled) return;
    window.__facebookCommentsCollectorInstalled = true;
    const collector = new Collector();
    browser.runtime.onMessage.addListener((message: CollectorRequest) => {
      if (message.type === 'collector:start') {
        collector.start(message.jobId, message.target, message.mode, message.rowLimit);
        return Promise.resolve({ ok: true });
      }
      if (message.type === 'collector:command') {
        collector.command(message.command);
        return Promise.resolve({ ok: true });
      }
      return undefined;
    });
  },
});
