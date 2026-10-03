import { browser } from 'wxt/browser';
import { commentFingerprint } from '../lib/collector/dom';
import {
  detectLinkedInBlockingState,
  extractLinkedInComments,
  extractLinkedInPostMetadata,
  findLinkedInCurrentSort,
  findLinkedInExpandActions,
  findLinkedInPostRoot,
  findLinkedInSortRevealAction,
  findMostRecentOption,
  getLinkedInCurrentSort,
  type LinkedInPostRoot,
} from '../lib/collector/linkedin-dom';
import type {
  CollectionJob,
  CollectionMode,
  CollectorRequest,
  JobCommand,
  JobStatus,
  PostTarget,
  RuntimeResult,
} from '../lib/types';

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

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const SORT_MENU_TIMEOUT_MS = 20_000;
const SORT_CONFIRM_TIMEOUT_MS = 30_000;
const CONTROL_LOAD_TIMEOUT_MS = 45_000;
const MAX_CONTROL_ATTEMPTS = 2;
const COMPLETION_QUIET_MS = 60_000;
const COUNT_MISMATCH_QUIET_MS = 120_000;

function activateControl(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', behavior: 'auto' });
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }

  const view = element.ownerDocument.defaultView;
  if (view) {
    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    if (typeof view.PointerEvent === 'function') {
      element.dispatchEvent(new view.PointerEvent('pointerdown', eventOptions));
      element.dispatchEvent(new view.PointerEvent('pointerup', eventOptions));
    }
    element.dispatchEvent(new view.MouseEvent('mousedown', eventOptions));
    element.dispatchEvent(new view.MouseEvent('mouseup', eventOptions));
  }
  element.click();
}

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

function waitForMutation(root: LinkedInPostRoot, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(changed);
    };
    const observer = new MutationObserver((mutations) => {
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
    const timeout = setTimeout(() => finish(false), timeoutMs);
  });
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
  extras: { completionReason?: string; isPartial?: boolean; error?: string } = {},
): Promise<void> {
  await send({ type: 'collector:status', jobId: state.jobId, status, action, ...extras });
}

async function sendLog(
  state: CollectorState,
  severity: 'info' | 'warning' | 'error',
  code: string,
  message: string,
  count?: number,
): Promise<void> {
  await send({ type: 'collector:log', jobId: state.jobId, severity, code, message, count });
}

class LinkedInCollector {
  private state?: CollectorState;

  start(jobId: string, target: PostTarget, mode: CollectionMode, rowLimit: number): void {
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

  private root(): LinkedInPostRoot | null {
    return this.state ? findLinkedInPostRoot(document, this.state.target) : null;
  }

  private async scan(root: LinkedInPostRoot): Promise<number> {
    const state = this.state;
    if (!state) return 0;
    const metadata = extractLinkedInPostMetadata(root);
    if (metadata.displayedCommentCount !== undefined) {
      state.displayedCommentCount = metadata.displayedCommentCount;
    }
    await send({ type: 'collector:metadata', jobId: state.jobId, metadata });

    const comments = extractLinkedInComments(root, state.target);
    const changed = comments.filter((comment) => {
      const fingerprint = commentFingerprint(comment);
      if (state.fingerprints.get(comment.id) === fingerprint) return false;
      state.fingerprints.set(comment.id, fingerprint);
      return true;
    });
    for (let index = 0; index < changed.length; index += 100) {
      const response = await send<{ job?: CollectionJob }>({
        type: 'collector:batch',
        jobId: state.jobId,
        comments: changed.slice(index, index + 100),
      });
      if (response?.job) state.uniqueTotal = response.job.counters.uniqueTotal;
    }
    if (changed.length > 0) state.lastProgressAt = Date.now();
    return changed.length;
  }

  private async ensureMostRecent(root: LinkedInPostRoot): Promise<boolean> {
    const state = this.state;
    if (!state || state.mode !== 'assisted') return true;
    let sawSortControl = false;
    let sawOption = false;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const currentRoot = this.root() ?? root;
      if (getLinkedInCurrentSort(currentRoot) === 'Most recent') return true;

      let sortControl = findLinkedInCurrentSort(currentRoot);
      if (!sortControl) {
        const revealAction = findLinkedInSortRevealAction(currentRoot);
        if (revealAction) {
          await sendStatus(
            state,
            'running',
            'Opening LinkedIn comments so the extension can select “Most recent”…',
          );
          activateControl(revealAction.element);
        }
        sortControl = await waitForValue(
          () => {
            const latest = this.root();
            return latest ? findLinkedInCurrentSort(latest) : undefined;
          },
          SORT_MENU_TIMEOUT_MS,
        );
      }
      if (!sortControl) {
        await sleep(1_500);
        continue;
      }
      sawSortControl = true;
      const latestRoot = this.root();
      if (latestRoot && getLinkedInCurrentSort(latestRoot) === 'Most recent') return true;

      let option = findMostRecentOption(document);
      if (!option) {
        await sendStatus(state, 'running', 'Switching LinkedIn comments to “Most recent”…');
        activateControl(sortControl);
        option = await waitForValue(() => findMostRecentOption(document), SORT_MENU_TIMEOUT_MS);
      }
      if (!option) continue;
      sawOption = true;
      activateControl(option);
      const confirmed = await waitForValue(
        () => {
          const latest = this.root();
          return latest && getLinkedInCurrentSort(latest) === 'Most recent' ? true : undefined;
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
      : !sawOption
        ? 'MOST_RECENT_OPTION_NOT_FOUND'
        : 'SORT_CHANGE_NOT_CONFIRMED';
    await sendLog(
      state,
      'warning',
      code,
      'LinkedIn did not expose or confirm “Most recent” after three automatic attempts.',
    );
    return false;
  }

  private async nudgeForDelayedComments(root: LinkedInPostRoot): Promise<boolean> {
    const comments = root.querySelectorAll<HTMLElement>('[id^="replaceableComment_urn:li:comment:"]');
    const target = comments.item(comments.length - 1) || (root instanceof HTMLElement ? root : null);
    const watcher = waitForMutation(root, 8_000);
    target?.scrollIntoView({ block: 'end', behavior: 'auto' });
    window.scrollBy({ top: Math.max(300, Math.round(window.innerHeight * 0.35)), behavior: 'auto' });
    return watcher;
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.state?.paused && !this.state.stopped) await sleep(300);
  }

  private async runManual(root: LinkedInPostRoot): Promise<void> {
    const state = this.state;
    if (!state) return;
    const changed = await this.scan(root);
    await sendStatus(
      state,
      'paused',
      changed
        ? `Scanned ${changed} new or changed visible LinkedIn comments. Load more, then scan again.`
        : 'No new visible comments found. Load more on LinkedIn or finish the collection.',
    );
  }

  private async runAssisted(initialRoot: LinkedInPostRoot): Promise<void> {
    const state = this.state;
    if (!state) return;
    let sortingRoot = initialRoot;
    while (!(await this.ensureMostRecent(sortingRoot))) {
      state.paused = true;
      await sendStatus(state, 'paused',
        'Automatic sorting could not be confirmed. Keep the LinkedIn post tab visible, then press Resume to retry automatically.', {
        isPartial: state.uniqueTotal > 0,
      });
      await this.waitWhilePaused();
      if (state.stopped) return;
      sortingRoot = this.root() ?? sortingRoot;
      await sendStatus(state, 'running', 'Retrying LinkedIn “Most recent” automatically…');
    }

    let bottomQuietSince: number | undefined;
    while (!state.stopped) {
      await this.waitWhilePaused();
      if (state.stopped) return;
      const blocking = detectLinkedInBlockingState(document);
      if (blocking) {
        state.paused = true;
        await sendLog(state, 'warning', 'LINKEDIN_BLOCKING_STATE', blocking);
        await sendStatus(state, 'paused', `${blocking} Resolve it manually, then resume.`, {
          isPartial: state.uniqueTotal > 0,
        });
        await this.waitWhilePaused();
        continue;
      }

      const root = this.root();
      if (!root) throw new Error('The LinkedIn post container is no longer available.');
      const changed = await this.scan(root);
      if (changed > 0) bottomQuietSince = undefined;
      if (state.uniqueTotal >= state.rowLimit) {
        await sendLog(state, 'warning', 'ROW_LIMIT_REACHED',
          `Collection stopped at the configured ${state.rowLimit.toLocaleString()} row limit.`);
        await sendStatus(state, 'completed', 'The configured row limit was reached.', {
          completionReason: `Stopped at the ${state.rowLimit.toLocaleString()} row safety limit.`,
          isPartial: true,
        });
        return;
      }

      const action = findLinkedInExpandActions(root)
        .filter((candidate) => !state.failedActions.has(candidate.key))[0];
      if (action) {
        bottomQuietSince = undefined;
        await sendStatus(
          state,
          'running',
          action.kind === 'text'
            ? 'Expanding a truncated LinkedIn comment…'
            : action.kind === 'replies'
              ? `Loading LinkedIn replies: ${action.label}`
              : `Loading more LinkedIn comments: ${action.label}`,
        );
        const watcher = waitForMutation(root, CONTROL_LOAD_TIMEOUT_MS);
        activateControl(action.element);
        const mutated = await watcher;
        if (!mutated) {
          const attempts = (state.actionAttempts.get(action.key) ?? 0) + 1;
          state.actionAttempts.set(action.key, attempts);
          if (attempts < MAX_CONTROL_ATTEMPTS) {
            await sendLog(state, 'info', 'CONTROL_RETRY',
              `“${action.label}” did not load within ${CONTROL_LOAD_TIMEOUT_MS / 1_000} seconds. Retrying once.`);
            await sleep(1_500);
          } else {
            state.failedActions.add(action.key);
            await sendLog(state, 'warning', 'CONTROL_FAILED',
              `LinkedIn did not respond to “${action.label}” after ${MAX_CONTROL_ATTEMPTS} attempts.`, 1);
          }
        } else {
          state.actionAttempts.delete(action.key);
          state.lastProgressAt = Date.now();
          await sleep(750);
        }
        continue;
      }

      const mutated = await this.nudgeForDelayedComments(root);
      if (mutated) {
        await sendStatus(state, 'running', 'LinkedIn changed the comments section; scanning it again…');
        await sleep(300);
        continue;
      }
      if (document.visibilityState === 'hidden') {
        bottomQuietSince = undefined;
        await sendStatus(state, 'running',
          'Keep the LinkedIn post tab visible so delayed comments can finish loading…');
        await sleep(5_000);
        continue;
      }

      const now = Date.now();
      bottomQuietSince ??= now;
      const displayedCountMissing = Boolean(
        state.displayedCommentCount && state.uniqueTotal < state.displayedCommentCount,
      );
      const requiredQuietMs = displayedCountMissing
        ? COUNT_MISMATCH_QUIET_MS
        : COMPLETION_QUIET_MS;
      const quietForMs = now - Math.max(bottomQuietSince, state.lastProgressAt);
      if (quietForMs >= requiredQuietMs) {
        const isPartial = displayedCountMissing || state.failedActions.size > 0;
        if (displayedCountMissing) {
          await sendLog(state, 'warning', 'DISPLAY_COUNT_MISMATCH',
            `LinkedIn displays ${state.displayedCommentCount?.toLocaleString()} comments, but ${state.uniqueTotal.toLocaleString()} unique rows were accessible.`);
        }
        if (isPartial) {
          state.paused = true;
          await sendStatus(state, 'paused',
            'LinkedIn still indicates missing items or an unresolved loader. Resume to retry, or finish to export the partial result.', {
              completionReason: 'Automatic completeness verification is unresolved after the extended slow-network wait.',
              isPartial: true,
            });
          await this.waitWhilePaused();
          if (state.stopped) return;
          bottomQuietSince = undefined;
          continue;
        } else {
          await sendStatus(state, 'completed', 'All available LinkedIn comments and replies were collected.', {
            completionReason: `The comments section stayed stable for ${requiredQuietMs / 1_000} seconds.`,
            isPartial: false,
          });
        }
        return;
      }

      const secondsRemaining = Math.max(1, Math.ceil((requiredQuietMs - quietForMs) / 1_000));
      await sendStatus(state, 'running',
        `Waiting ${secondsRemaining}s for delayed LinkedIn comments and replies…`);
      await sleep(Math.min(5_000, requiredQuietMs - quietForMs));
    }
  }

  private async run(): Promise<void> {
    const state = this.state;
    if (!state || state.running || state.stopped) return;
    state.running = true;
    try {
      await sendStatus(state, 'running', 'Locating the LinkedIn post…');
      const root = await waitForValue(() => this.root() ?? undefined, 30_000, 500);
      if (!root) throw new Error('No supported LinkedIn post was found on this page.');
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
  main(ctx) {
    const collector = new LinkedInCollector();
    const listener = (message: CollectorRequest) => {
      if (message.type === 'collector:start') {
        collector.start(message.jobId, message.target, message.mode, message.rowLimit);
        return Promise.resolve({ ok: true });
      }
      if (message.type === 'collector:command') {
        collector.command(message.command);
        return Promise.resolve({ ok: true });
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(listener));
  },
});
