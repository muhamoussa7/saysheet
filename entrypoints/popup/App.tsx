import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { errorMessage, sendRuntimeMessage } from '../../lib/runtime';
import type { CollectionJob, CollectionMode } from '../../lib/types';
import {
  parsePostUrl,
  samePost,
  shortPostLabel,
} from '../../lib/url';

const ACKNOWLEDGEMENT_KEY = 'assisted-collection-acknowledged';

export default function App() {
  const [activeTab, setActiveTab] = useState<{ id: number; url: string }>();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<CollectionMode>('assisted');
  const [rowLimit, setRowLimit] = useState(10_000);
  const [acknowledged, setAcknowledged] = useState(false);
  const [acknowledgedBefore, setAcknowledgedBefore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [latestJob, setLatestJob] = useState<CollectionJob>();

  useEffect(() => {
    void Promise.all([
      browser.tabs.query({ active: true, currentWindow: true }),
      browser.storage.local.get(ACKNOWLEDGEMENT_KEY),
      sendRuntimeMessage<CollectionJob[]>({ type: 'job:list' }).catch(() => []),
    ]).then(([tabs, stored, jobs]) => {
      const tab = tabs[0];
      if (tab?.id !== undefined) {
        const tabUrl = tab.url ?? '';
        setActiveTab({ id: tab.id, url: tabUrl });
        const parsed = parsePostUrl(tabUrl);
        if (parsed.ok) setUrl(parsed.target.canonicalUrl);
      }
      const previous = Boolean(stored[ACKNOWLEDGEMENT_KEY]);
      setAcknowledgedBefore(previous);
      setAcknowledged(previous);
      setLatestJob(jobs[0]);
    });
  }, []);

  const parsed = useMemo(() => parsePostUrl(url), [url]);
  const needsAcknowledgement = mode === 'assisted' && !acknowledgedBefore;

  async function startCollection() {
    setError('');
    setNotice('');
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!activeTab) {
      setError('No active browser tab is available.');
      return;
    }
    if (needsAcknowledgement && !acknowledged) {
      setError('Confirm that you have permission before using assisted collection.');
      return;
    }

    setBusy(true);
    try {
      const navigate = !samePost(activeTab.url, parsed.target.canonicalUrl);
      if (navigate) {
        const origin = parsed.target.platform === 'linkedin'
          ? 'https://*.linkedin.com/*'
          : 'https://*.facebook.com/*';
        const granted = await browser.permissions.request({
          origins: [origin],
        });
        if (!granted) {
          await browser.tabs.update(activeTab.id, {
            url: parsed.target.canonicalUrl,
            active: true,
          });
          setNotice('The post was opened. When it finishes loading, reopen this extension and start again.');
          return;
        }
      }

      if (mode === 'assisted' && acknowledged) {
        await browser.storage.local.set({ [ACKNOWLEDGEMENT_KEY]: true });
      }

      await sendRuntimeMessage<CollectionJob>({
        type: 'job:create',
        target: parsed.target,
        mode,
        rowLimit,
        tabId: activeTab.id,
        navigate,
      });
      setNotice('Collection started. The progress dashboard was opened in a new tab.');
      window.setTimeout(() => window.close(), 900);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openLatest() {
    if (!latestJob) return;
    await browser.tabs.create({
      url: browser.runtime.getURL(`/dashboard.html?job=${encodeURIComponent(latestJob.id)}`),
    });
    window.close();
  }

  return (
    <main className="popup-shell">
      <header className="brand">
        <div className="brand-mark" aria-hidden="true">XLS</div>
        <div>
          <p className="eyebrow">LOCAL CHROME TOOL</p>
          <h1>Saysheet</h1>
        </div>
      </header>

      <section className="card">
        <label htmlFor="post-url">Facebook or LinkedIn post link</label>
        <textarea
          id="post-url"
          rows={3}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.facebook.com/... or https://www.linkedin.com/..."
          spellCheck={false}
        />
        <div className={`validation ${parsed.ok ? 'valid' : ''}`}>
          {parsed.ok ? `Ready · ${shortPostLabel(parsed.target)}` : parsed.error}
        </div>
      </section>

      <section className="card mode-card">
        <span className="field-label">Collection mode</span>
        <label className={`mode-option ${mode === 'manual' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="mode"
            checked={mode === 'manual'}
            onChange={() => setMode('manual')}
          />
          <span>
            <strong>Manual scan</strong>
            <small>Export what is loaded; scan again after you load more.</small>
          </span>
        </label>
        <label className={`mode-option ${mode === 'assisted' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="mode"
            checked={mode === 'assisted'}
            onChange={() => setMode('assisted')}
          />
          <span>
            <strong>Assisted collection</strong>
            <small>
              {parsed.ok && parsed.target.platform === 'linkedin'
                ? 'Select Most recent and progressively open every comment and reply group.'
                : 'Select All comments, auto-scroll, and progressively open every reply group.'}
            </small>
          </span>
        </label>
      </section>

      <section className="settings-row">
        <label htmlFor="row-limit">Safety row limit</label>
        <input
          id="row-limit"
          type="number"
          min={100}
          max={50_000}
          step={100}
          value={rowLimit}
          onChange={(event) => setRowLimit(Math.min(50_000, Math.max(100, Number(event.target.value))))}
        />
      </section>

      {needsAcknowledgement && mode === 'assisted' && (
        <label className="consent">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>I have permission and a lawful basis to export these comments.</span>
        </label>
      )}

      {error && <div className="message error" role="alert">{error}</div>}
      {notice && <div className="message success" role="status">{notice}</div>}

      <button
        className="primary-button"
        disabled={busy || !parsed.ok}
        onClick={() => void startCollection()}
      >
        {busy ? 'Starting…' : mode === 'assisted' ? 'Start assisted collection' : 'Scan loaded comments'}
      </button>

      {latestJob && (
        <button className="secondary-button" onClick={() => void openLatest()}>
          Open latest collection · {latestJob.counters.uniqueTotal.toLocaleString()} rows
        </button>
      )}

      <footer>
        Data stays on this computer. The tool never asks for a Facebook or LinkedIn password.
        Use it only for posts and personal data you are authorized to process.
      </footer>
    </main>
  );
}
