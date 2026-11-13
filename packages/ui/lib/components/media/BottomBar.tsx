import { IconVideo, IconHistory, IconSettings, IconDownload } from './icons';
import { cn } from '../../utils';

export type BottomBarView = 'main' | 'settings' | 'history' | 'downloads';

export const BottomBar = ({
  isLight,
  view,
  onViewChange,
  actions,
  borderB,
  mediaCount,
  downloadCount,
  compact = false,
  merged = false,
}: {
  isLight: boolean;
  view: BottomBarView;
  onViewChange: (v: BottomBarView) => void;
  actions?: React.ReactNode;
  borderB?: string;
  mediaCount?: number;
  downloadCount?: number;
  compact?: boolean;
  merged?: boolean;
}) => {
  const active = (v: string) => view === v;
  const btnCls = (v: string) =>
    cn(
      'flex items-center rounded-lg font-medium transition',
      compact ? 'gap-1 px-2 py-1.5 text-[10px]' : 'flex-col gap-0.5 px-3 py-1.5 text-[10px]',
      active(v)
        ? isLight
          ? 'bg-blue-50 text-blue-600'
          : 'bg-blue-500/10 text-blue-400'
        : isLight
          ? 'text-gray-400 hover:text-gray-600'
          : 'text-gray-500 hover:text-gray-300',
    );

  const mediaBadge = mediaCount && mediaCount > 0 ? mediaCount : null;
  const downloadBadge = downloadCount && downloadCount > 0 ? downloadCount : null;

  if (merged) {
    return (
      <div
        className={cn(
          'mt-auto flex shrink-0 items-center gap-2 border-t px-3 py-2.5',
          isLight ? 'border-gray-200 bg-white' : 'border-white/[0.08] bg-[#0f1117]',
        )}>
        <button
          title="Media and downloads"
          onClick={() => onViewChange('main')}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-[10px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            isLight ? 'text-gray-600 hover:bg-gray-50' : 'text-gray-300 hover:bg-white/[0.04]',
          )}>
          <span
            title="Active and queued downloads"
            aria-label={`Active and queued downloads: ${downloadCount ?? 0}`}
            className="flex items-center gap-1 [&>svg]:h-3.5 [&>svg]:w-3.5">
            <IconDownload />
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5 tabular-nums',
                isLight ? 'bg-gray-100 text-gray-700' : 'bg-white/[0.08] text-gray-200',
              )}>
              {downloadCount ?? 0}
            </span>
          </span>
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mt-auto flex shrink-0 items-center justify-around border-t px-2 py-1',
        borderB ? `border-${borderB}` : isLight ? 'border-gray-200 bg-white' : 'border-white/[0.06] bg-[#0f1117]',
      )}>
      <button className={btnCls('main')} onClick={() => onViewChange('main')} title="Media">
        <IconVideo />
        {compact ? (
          mediaBadge ? (
            <span className="tabular-nums">{mediaBadge}</span>
          ) : null
        ) : (
          <span>Media{mediaBadge ? ` (${mediaBadge})` : ''}</span>
        )}
      </button>
      <button className={btnCls('downloads')} onClick={() => onViewChange('downloads')} title="Downloads">
        <IconDownload />
        {compact ? (
          downloadBadge ? (
            <span className="tabular-nums">{downloadBadge}</span>
          ) : null
        ) : (
          <span>Downloads{downloadBadge ? ` (${downloadBadge})` : ''}</span>
        )}
      </button>
      {!compact ? (
        <>
          <button className={btnCls('history')} onClick={() => onViewChange('history')} title="History">
            <IconHistory />
            <span>History</span>
          </button>
          <button className={btnCls('settings')} onClick={() => onViewChange('settings')} title="Settings">
            <IconSettings />
            <span>Settings</span>
          </button>
        </>
      ) : null}
      {actions ? (
        <>
          <div className={cn('h-5 w-px', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
          {actions}
        </>
      ) : null}
    </div>
  );
};
