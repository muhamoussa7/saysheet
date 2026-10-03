import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { getJobBundle } from '../../lib/db';
import { createWorkbook, workbookFilename } from '../../lib/export-workbook';
import { errorMessage, sendRuntimeMessage } from '../../lib/runtime';
import type { CollectionJob, JobCommand } from '../../lib/types';

const jobId = new URLSearchParams(location.search).get('job') ?? '';

function formatDate(raw: string | undefined): string {
  return raw ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(raw)) : '—';
}

function statusTone(status: CollectionJob['status']): string {
  if (status === 'completed') return 'complete';
  if (status === 'error' || status === 'stopped') return 'warning';
  if (status === 'running' || status === 'exporting') return 'running';
  return 'neutral';
}

export default function App() {
  const [job, setJob] = useState<CollectionJob>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!jobId) {
      setError('No collection job was specified.');
      setLoading(false);
      return;
    }
    try {
      const current = await sendRuntimeMessage<CollectionJob | undefined>({
        type: 'job:get',
        jobId,
      });
      if (current) setJob(current);
      else if (!downloadStarted) setError('This collection was cleared or no longer exists.');
    } catch (cause) {
      if (!downloadStarted) setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [downloadStarted]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const progress = useMemo(() => {
    if (!job) return 0;
    return Math.min(100, Math.max(1, (job.counters.uniqueTotal / job.rowLimit) * 100));
  }, [job]);

  async function command(value: JobCommand) {
    if (!job) return;
    setBusy(true);
    setError('');
    try {
      const updated = await sendRuntimeMessage<CollectionJob>({
        type: 'job:command',
        jobId: job.id,
        command: value,
      });
      setJob(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const platform = job?.target.platform ??
    (job?.target.canonicalUrl.includes('linkedin.com') ? 'linkedin' : 'facebook');
  const platformName = platform === 'linkedin' ? 'LinkedIn' : 'Facebook';

  async function focusSourcePost() {
    if (!job) return;
    try {
      await browser.tabs.update(job.tabId, { active: true });
    } catch {
      setError(`The ${platformName} tab is no longer open. Open the post again to continue.`);
    }
  }

  async function exportExcel() {
    if (!job || job.counters.uniqueTotal === 0) return;
    setBusy(true);
    setError('');
    setMessage('Building the Excel workbook locally…');
    try {
      const bundle = await getJobBundle(job.id);
      if (!bundle) throw new Error('The local collection data could not be found.');
      const buffer = await createWorkbook(bundle);
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const objectUrl = URL.createObjectURL(blob);
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: workbookFilename(bundle),
        saveAs: true,
      });
      await sendRuntimeMessage<void>({
        type: 'download:register',
        jobId: job.id,
        downloadId,
      });
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setDownloadStarted(true);
      setMessage('Download started. The temporary collection will be deleted after Chrome confirms completion.');
    } catch (cause) {
      setError(errorMessage(cause));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  async function clearCollection() {
    if (!job || !window.confirm('Delete this local collection and all of its temporary comments?')) return;
    setBusy(true);
    try {
      await sendRuntimeMessage<void>({ type: 'job:clear', jobId: job.id });
      setJob(undefined);
      setMessage('The local collection was deleted.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="center-state">Loading collection…</div>;
  if (!job && downloadStarted) {
    return (
      <div className="center-state success-state">
        <div className="success-icon">✓</div>
        <h1>Excel download complete</h1>
        <p>The temporary comments and checkpoints were deleted from the extension.</p>
      </div>
    );
  }
  if (!job) return <div className="center-state error-state"><h1>Collection unavailable</h1><p>{error}</p></div>;

  const canExport = job.counters.uniqueTotal > 0 && !['running', 'ready', 'exporting'].includes(job.status);
  const isActive = ['running', 'ready'].includes(job.status);

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">SAYSHEET</p>
          <h1>Collection dashboard</h1>
          <a href={job.target.canonicalUrl} target="_blank" rel="noreferrer">
            {platformName} · {job.target.type} · {job.target.postId ?? 'permalink'}
          </a>
        </div>
        <span className={`status-pill ${statusTone(job.status)}`}>{job.status}</span>
      </header>

      <section className="status-panel">
        <div className="status-copy">
          <span className={isActive ? 'pulse' : 'dot'} aria-hidden="true" />
          <div>
            <strong>{job.action}</strong>
            <small>Updated {formatDate(job.updatedAt)}</small>
          </div>
        </div>
        <div className="progress-track" aria-label={`${progress.toFixed(0)} percent of row safety limit`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <small className="limit-copy">{job.counters.uniqueTotal.toLocaleString()} of {job.rowLimit.toLocaleString()} safety-limit rows</small>
      </section>

      <section className="metric-grid">
        <article><span>Unique rows</span><strong>{job.counters.uniqueTotal.toLocaleString()}</strong></article>
        <article><span>Top-level</span><strong>{job.counters.topLevel.toLocaleString()}</strong></article>
        <article><span>Replies</span><strong>{job.counters.replies.toLocaleString()}</strong></article>
        <article><span>Duplicates ignored</span><strong>{job.counters.duplicates.toLocaleString()}</strong></article>
      </section>

      <section className="details-grid">
        <article className="detail-card">
          <h2>Collection details</h2>
          <dl>
            <div><dt>Mode</dt><dd>{job.mode}</dd></div>
            <div><dt>Comment sorting</dt><dd>{job.metadata?.currentSort ?? 'Not detected'}</dd></div>
            <div><dt>{platformName} UI</dt><dd>{job.metadata?.interfaceLanguage ?? 'Unknown'}</dd></div>
            <div><dt>Started</dt><dd>{formatDate(job.startedAt)}</dd></div>
            <div><dt>Failed controls</dt><dd>{job.counters.failedControls}</dd></div>
            <div><dt>Partial</dt><dd>{job.isPartial ? 'Yes' : 'No'}</dd></div>
          </dl>
        </article>

        <article className="detail-card actions-card">
          <h2>Controls</h2>
          <div className="button-grid">
            {job.status === 'running' && (
              <button onClick={() => void command('pause')} disabled={busy}>Pause</button>
            )}
            {job.status === 'paused' && (
              <button className="primary" onClick={() => void command(job.mode === 'manual' ? 'rescan' : 'resume')} disabled={busy}>
                {job.mode === 'manual' ? 'Scan loaded again' : 'Resume'}
              </button>
            )}
            {job.status === 'paused' && (
              <button onClick={() => void command('finish')} disabled={busy}>Finish collection</button>
            )}
            {isActive && (
              <button className="danger" onClick={() => void command('stop')} disabled={busy}>Stop</button>
            )}
            <button onClick={() => void focusSourcePost()}>Show {platformName} tab</button>
            <button className="primary" onClick={() => void exportExcel()} disabled={busy || !canExport}>
              {busy ? 'Working…' : 'Download Excel'}
            </button>
            <button className="ghost danger-text" onClick={() => void clearCollection()} disabled={busy}>
              Delete local collection
            </button>
          </div>
          {!canExport && job.counters.uniqueTotal > 0 && isActive && (
            <p className="hint">Pause or stop collection before exporting a partial workbook.</p>
          )}
        </article>
      </section>

      {job.completionReason && <div className="notice"><strong>Completion:</strong> {job.completionReason}</div>}
      {job.lastError && <div className="notice error"><strong>Issue:</strong> {job.lastError}</div>}
      {message && <div className="notice success">{message}</div>}
      {error && <div className="notice error">{error}</div>}

      <footer>
        Comments remain in this extension only until the Excel download completes. No data is sent to a server.
      </footer>
    </main>
  );
}
