import { Header } from './components/Header';
import { PasteUrlRow } from './components/PasteUrlRow';
import { SettingCard, SettingRow } from './components/SettingCard';
import { SkeletonFallback, ErrorFallback } from './components/SkeletonFallback';
import { useMediaPage } from './hooks/useMediaPage';
import { buildMediaSections } from './lib/media-sections';
import { DownloadDetailsView } from './views/DownloadDetailsView';
import { MEDIA_MESSAGE, withErrorBoundary, withSuspense, mediaBadgeLabel, formatDate } from '@extension/shared';
import { mediaSettingsStorage } from '@extension/storage';
import {
  cn,
  BottomBar,
  DownloadRow,
  EmptyState,
  FilenameTemplateField,
  IconCheck,
  IconHistory,
  IconLink,
  IconPicker,
  IconVideo,
  IconX,
  IconXCircle,
  MediaCard,
  PaywallDialog,
  SkeletonCard,
  Toggle,
} from '@extension/ui';
import { useState } from 'react';

const Popup = () => {
  const {
    tabId,
    currentMedia,
    isLoading,
    downloadState,
    setDownloadState,
    selectedVariants,
    setSelectedVariants,
    view,
    setView,
    moreMenuId,
    setMoreMenuId,
    editingId,
    setEditingId,
    editName,
    setEditName,
    downloads,
    settings,
    history,
    isLight,
    onDownload,
    closePaywall,
    buyProduct,
    restorePurchase,
    manageSubscription,
    onCancel,
    onPause,
    onRetry,
    onClearDownloads,
    onReorder,
    clearDetectionsForTab,
    copyUrl,
    startEdit,
    toggleHlsMerge,
    clearHistory,
    bg,
    text,
    textMuted,
    hoverBg,
  } = useMediaPage();
  const [pasteOpen, setPasteOpen] = useState(false);

  const ACTIVE_STAGES = new Set([
    'queued',
    'init',
    'fetch-manifest',
    'download-video',
    'download-audio',
    'mux',
    'finalize',
  ]);
  // Sort: queued (by position) → running → terminal (newest first)
  const downloadList = Object.values(downloads).sort((a, b) => {
    if (a.stage === 'queued' && b.stage === 'queued') return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
    if (a.stage === 'queued') return 1;
    if (b.stage === 'queued') return -1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  const activeDownloadCount = downloadList.filter(d => ACTIVE_STAGES.has(d.stage)).length;
  const FINISHED_STAGES = new Set(['success', 'failed', 'cancelled']);
  const currentFinishedKeys = downloadList
    .filter(entry => entry.item?.tabId === tabId && FINISHED_STAGES.has(entry.stage))
    .map(entry => entry.key);
  const otherFinishedKeys = downloadList
    .filter(entry => entry.item?.tabId !== tabId && FINISHED_STAGES.has(entry.stage))
    .map(entry => entry.key);

  const startPicker = () => {
    chrome.runtime
      .sendMessage({ type: MEDIA_MESSAGE.PICKER_START, payload: { tabId: tabId ?? undefined } })
      .catch(() => undefined);
    window.close();
  };

  const actionClass = cn(
    'flex min-w-0 items-center justify-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0',
    isLight
      ? 'border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300 hover:bg-gray-100'
      : 'border-white/[0.08] bg-white/[0.04] text-gray-200 hover:bg-white/[0.08]',
  );
  const popupActions = (
    <>
      <button
        className={actionClass}
        title="Select a video on this page (Alt+Shift+V)"
        disabled={tabId === null}
        onClick={startPicker}>
        <IconPicker />
        <span>Pick video</span>
      </button>
      <button
        className={cn(
          actionClass,
          pasteOpen &&
            (isLight ? 'border-blue-200 bg-blue-50 text-blue-600' : 'border-blue-500/30 bg-blue-500/15 text-blue-400'),
        )}
        title="Add a media link manually"
        aria-expanded={pasteOpen}
        onClick={() => setPasteOpen(o => !o)}>
        <IconLink />
        <span>Add link</span>
      </button>
    </>
  );

  /* ── Standalone download details window ────────
     Only activated when popup HTML is opened with #download-details in URL
     (via chrome.windows.create from the download interceptor). The normal
     browser-action popup never reaches this branch — its hash is empty so
     view stays 'main'. */
  if (view === 'download-details') {
    return (
      <div className={cn('h-screen w-screen font-sans', bg, text)}>
        <DownloadDetailsView downloads={downloads} isLight={isLight} />
      </div>
    );
  }

  /* ── Settings View ─────────────────────────────── */
  if (view === 'settings') {
    return (
      <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
        <Header title="Settings" isLight={isLight} onBack={() => setView('main')} />

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <SettingCard isLight={isLight}>
            <SettingRow
              title="Merge DASH streams"
              subtitle="Combine video + audio tracks (HLS always merges)"
              isLight={isLight}>
              <Toggle checked={settings?.enableHlsMerging ?? false} onChange={toggleHlsMerge} isLight={isLight} />
            </SettingRow>
          </SettingCard>
          <SettingCard isLight={isLight}>
            <FilenameTemplateField
              value={settings?.filenameTemplate ?? ''}
              onChange={next => mediaSettingsStorage.set(prev => ({ ...prev, filenameTemplate: next }))}
              isLight={isLight}
            />
          </SettingCard>
        </div>

        <BottomBar
          isLight={isLight}
          view="settings"
          onViewChange={setView}
          actions={popupActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
          compact
          merged
        />
      </div>
    );
  }

  /* ── History View ──────────────────────────────── */
  if (view === 'history') {
    return (
      <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
        <Header
          title="History"
          isLight={isLight}
          onBack={() => setView('main')}
          action={
            history.length > 0 ? (
              <button
                onClick={clearHistory}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                  isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10',
                )}>
                Clear all
              </button>
            ) : null
          }
        />

        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <EmptyState
              icon={<IconHistory />}
              title="No downloads yet"
              subtitle="Your download history will appear here"
              isLight={isLight}
              className="py-20"
            />
          ) : (
            <div className="space-y-px px-2 py-2">
              {history.map(item => (
                <button
                  key={item.id}
                  className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition', hoverBg)}
                  onClick={() => onDownload(item)}>
                  <div
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                      item.status === 'success'
                        ? isLight
                          ? 'bg-emerald-100 text-emerald-600'
                          : 'bg-emerald-500/15 text-emerald-400'
                        : isLight
                          ? 'bg-red-100 text-red-600'
                          : 'bg-red-500/15 text-red-400',
                    )}>
                    {item.status === 'success' ? <IconCheck /> : <IconXCircle />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-xs font-medium', text)}>
                      {item.title ?? item.fileName ?? item.url}
                    </p>
                    <p className={cn('text-[10px]', textMuted)}>
                      {mediaBadgeLabel(item)} &middot; {formatDate(item.downloadedAt)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <BottomBar
          isLight={isLight}
          view="history"
          onViewChange={setView}
          actions={popupActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
          compact
          merged
        />
      </div>
    );
  }

  const sections = buildMediaSections(
    tabId,
    currentMedia.map(item => ({ ...item, tabId: tabId ?? undefined })),
    downloadList,
  );
  const queueTotal = downloadList.filter(entry => entry.stage === 'queued').length;
  const renderRows = (rows: typeof sections.current) =>
    rows.map(row =>
      row.type === 'download' ? (
        <DownloadRow
          key={`download:${row.key}`}
          entry={row.entry}
          isLight={isLight}
          onRetry={onRetry}
          onPause={onPause}
          onCancel={onCancel}
          onRemove={key => onClearDownloads([key])}
          onReorder={onReorder}
          queueTotal={queueTotal}
        />
      ) : (
        <MediaCard
          key={`media:${row.key}`}
          item={row.item}
          isLight={isLight}
          downloadState={downloadState}
          downloads={downloads}
          selectedVariants={selectedVariants}
          setSelectedVariants={setSelectedVariants}
          settings={settings}
          moreMenuId={moreMenuId}
          setMoreMenuId={setMoreMenuId}
          editingId={editingId}
          setEditingId={setEditingId}
          editName={editName}
          setEditName={setEditName}
          onDownload={onDownload}
          onCancel={onCancel}
          startEdit={startEdit}
          copyUrl={copyUrl}
          onDismiss={() => {
            if (row.item.tabId !== undefined) clearDetectionsForTab(row.item.tabId);
          }}
        />
      ),
    );

  /* ── Main View ─────────────────────────────────── */
  return (
    <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
      {/* Error toast */}
      {downloadState.error ? (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-xs font-medium',
            isLight ? 'bg-red-50 text-red-700' : 'bg-red-500/10 text-red-400',
          )}>
          <span className="flex-1">{downloadState.error}</span>
          <button
            onClick={() => setDownloadState(s => ({ ...s, error: null }))}
            className="opacity-60 hover:opacity-100">
            <IconX />
          </button>
        </div>
      ) : null}

      {downloadList.some(entry =>
        ['queued', 'init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize'].includes(
          entry.stage,
        ),
      ) ? (
        <button
          className="mx-4 my-2 rounded-md border px-3 py-2 text-xs"
          title="Pause downloads; non-Range streams restart on Resume. Incomplete live snapshots are stopped."
          onClick={() => chrome.runtime.sendMessage({ type: 'media/pause-all' })}>
          Pause all
        </button>
      ) : null}
      {downloadList.some(entry => entry.stage === 'paused') ? (
        <button
          className="mx-4 my-2 rounded-md border px-3 py-2 text-xs"
          onClick={() => chrome.runtime.sendMessage({ type: 'media/resume-all' })}>
          Resume all
        </button>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-px">
            <SkeletonCard isLight={isLight} />
            <SkeletonCard isLight={isLight} />
          </div>
        ) : (
          <>
            <section aria-label="Current page">
              <div className="flex items-center justify-between px-4 pb-1 pt-3">
                <h2 className={cn('text-[11px] font-semibold', textMuted)}>Current page</h2>
                <div className="flex items-center gap-2">
                  {currentFinishedKeys.length > 0 ? (
                    <button
                      onClick={() => onClearDownloads(currentFinishedKeys)}
                      className={cn(
                        'rounded-md px-2 py-1 text-[11px] transition',
                        isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10',
                      )}>
                      Clear finished
                    </button>
                  ) : null}
                  <span
                    title="Detected media on this page"
                    aria-label={`Detected media on this page: ${currentMedia.length}`}
                    className={cn('flex items-center gap-1 text-[10px] [&>svg]:h-3.5 [&>svg]:w-3.5', textMuted)}>
                    <IconVideo />
                    <span
                      className={cn(
                        'rounded-md px-1.5 py-0.5 font-medium tabular-nums',
                        isLight ? 'bg-blue-50 text-blue-600' : 'bg-blue-500/15 text-blue-400',
                      )}>
                      {currentMedia.length}
                    </span>
                  </span>
                </div>
              </div>
              {sections.current.length ? (
                renderRows(sections.current)
              ) : (
                <EmptyState
                  icon={<IconVideo />}
                  title="No media detected"
                  subtitle="Play a video or audio on this page to capture it"
                  isLight={isLight}
                  className="py-10"
                />
              )}
            </section>
            {sections.other.length > 0 ? (
              <section
                aria-label="Other downloads"
                className={cn('mt-3 border-t', isLight ? 'border-gray-200' : 'border-white/[0.06]')}>
                <div className="flex items-center justify-between px-4 pb-1 pt-3">
                  <h2 className={cn('text-[11px] font-semibold', textMuted)}>Downloads from other pages</h2>
                  {otherFinishedKeys.length > 0 ? (
                    <button
                      onClick={() => onClearDownloads(otherFinishedKeys)}
                      className={cn(
                        'rounded-md px-2 py-1 text-[11px] transition',
                        isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10',
                      )}>
                      Clear finished
                    </button>
                  ) : null}
                </div>
                {renderRows(sections.other)}
              </section>
            ) : null}
          </>
        )}
      </div>

      {pasteOpen ? <PasteUrlRow isLight={isLight} tabId={tabId} onClose={() => setPasteOpen(false)} /> : null}

      <BottomBar
        isLight={isLight}
        view="main"
        onViewChange={setView}
        actions={popupActions}
        mediaCount={currentMedia.length}
        downloadCount={activeDownloadCount}
        compact
        merged
      />

      <PaywallDialog
        open={Boolean(downloadState.paywall)}
        isLight={isLight}
        free={downloadState.paywall?.free}
        credits={downloadState.paywall?.credits}
        subscription={downloadState.paywall?.subscription}
        error={downloadState.error}
        onClose={closePaywall}
        onPurchase={productKey => void buyProduct(productKey)}
        onRestore={restorePurchase}
        onManage={() => void manageSubscription()}
      />
    </div>
  );
};

export default withErrorBoundary(withSuspense(Popup, <SkeletonFallback />), ErrorFallback);
