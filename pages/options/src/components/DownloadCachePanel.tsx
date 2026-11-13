import { formatFileSize, useStorage } from '@extension/shared';
import { mediaSettingsStorage } from '@extension/storage';
import { useEffect, useState } from 'react';

type CacheRow = {
  key: string;
  title: string;
  state: string;
  allocatedBytes: number;
  expiresAt?: number;
  clearable: boolean;
};
type Overview = {
  rows: CacheRow[];
  allocatedBytes: number;
  networkCost?: { supported: boolean; metered: boolean };
  persistence?: { persisted: boolean; supported: boolean };
};

export const DownloadCachePanel = ({ isLight }: { isLight: boolean }) => {
  const settings = useStorage(mediaSettingsStorage);
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'media/cache-list' });
      if (!result?.ok) throw new Error(result?.error ?? 'Cache unavailable');
      setOverview(result);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const clear = async (keys?: string[]) => {
    setBusy(true);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'media/cache-clear', keys });
      if (!result?.ok) throw new Error(result?.error ?? 'Cache cleanup failed');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={`rounded-xl border p-5 ${isLight ? 'border-gray-200 bg-white' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Partial download cache</h2>
        <button type="button" className="rounded-md border px-3 py-1 text-xs" onClick={() => void load()}>
          Refresh cache
        </button>
      </div>
      <p className="mt-2 text-xs opacity-70">
        Files retained for download recovery: {formatFileSize(overview?.allocatedBytes) || '0 B'}. Saved outputs are
        retained for 24 hours.
      </p>
      <p className="mt-1 text-xs opacity-70">
        {overview?.persistence?.persisted
          ? 'Persistent storage granted'
          : overview
            ? 'Browser-managed storage; persistence was not granted'
            : 'Checking storage protection…'}
      </p>
      <div className="mt-4 space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.pauseOnMeteredNetwork ?? true}
            onChange={event =>
              void mediaSettingsStorage.set(previous => ({ ...previous, pauseOnMeteredNetwork: event.target.checked }))
            }
          />
          Pause downloads on metered networks
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.manuallyMetered ?? false}
            onChange={event =>
              void mediaSettingsStorage.set(previous => ({ ...previous, manuallyMetered: event.target.checked }))
            }
          />
          Current connection is metered
        </label>
        <p className="opacity-70">
          {overview?.networkCost?.supported
            ? 'Connection changes are detected automatically.'
            : 'Chrome does not expose the connection type here. Mark tethered or metered connections above; network speed is not used to infer cellular service.'}{' '}
          Resume explicitly to allow a paused download on the current connection.
        </p>
      </div>
      <label className="mt-4 flex items-center gap-3 text-sm">
        Keep partial downloads for
        <input
          aria-label="Cache retention days"
          type="number"
          min="1"
          max="365"
          className="w-20 rounded border bg-transparent px-2 py-1"
          value={settings.cacheRetentionDays ?? 7}
          onChange={event => {
            const days = Number(event.target.value);
            if (Number.isInteger(days) && days >= 1 && days <= 365)
              void mediaSettingsStorage.set(previous => ({ ...previous, cacheRetentionDays: days }));
          }}
        />
        days
      </label>
      <p className="mt-3 text-xs opacity-70">
        Discarding a paused or failed download cancels it and removes its cached files. Active downloads remain
        protected.
      </p>
      <button
        type="button"
        disabled={busy || !overview?.rows.some(row => row.clearable)}
        className="mt-3 rounded-md border px-3 py-2 text-xs disabled:opacity-40"
        onClick={() => void clear()}>
        Discard paused / failed cache
      </button>
      <div className="mt-4 space-y-3">
        {overview?.rows.map(row => (
          <div key={row.key} className="flex items-center gap-3 text-xs">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{row.title}</p>
              <p className="mt-1 opacity-60">
                {row.state} · {formatFileSize(row.allocatedBytes)}
                {row.expiresAt ? ` · retained until ${new Date(row.expiresAt).toLocaleString()}` : ''}
              </p>
            </div>
            <button
              type="button"
              disabled={busy || !row.clearable}
              className="rounded-md border px-2 py-1 disabled:opacity-40"
              onClick={() => void clear([row.key])}>
              Discard cache
            </button>
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-red-500">
          {error}
        </p>
      ) : null}
    </section>
  );
};
