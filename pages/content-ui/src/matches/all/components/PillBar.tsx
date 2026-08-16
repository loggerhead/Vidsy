import { IcoDown, IcoStop } from './icons';
import { GLASS, GLASS_BORDER, BLUR, TEXT, HOVER } from './tokens';
import type { MediaDownloadProgress } from '@extension/shared';

export const PillBar = ({
  isBusy,
  prog,
  onExpand,
}: {
  isBusy: boolean;
  prog: MediaDownloadProgress | null;
  onExpand: () => void;
}) => (
  <button
    type="button"
    aria-label={isBusy ? 'Show download progress' : 'Show download options'}
    title={isBusy ? 'Vidsy download in progress' : 'Vidsy download options'}
    onClick={onExpand}
    style={{
      position: 'relative',
      width: 30,
      height: 36,
      display: 'grid',
      placeItems: 'center',
      color: prog?.stage === 'failed' ? '#f87171' : prog?.stage === 'success' ? '#86efac' : TEXT,
      background: GLASS,
      backdropFilter: BLUR,
      WebkitBackdropFilter: BLUR,
      border: `1px solid ${GLASS_BORDER}`,
      borderRadius: 9,
      boxShadow: '0 4px 16px rgba(0,0,0,0.48)',
      cursor: 'pointer',
    }}
    onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
    onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = GLASS)}>
    {isBusy && !['success', 'failed'].includes(prog?.stage ?? '') ? <IcoStop /> : <IcoDown />}
    {isBusy && (
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: 4,
          bottom: 4,
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: prog?.stage === 'failed' ? '#f87171' : prog?.stage === 'success' ? '#86efac' : '#60a5fa',
          boxShadow: '0 0 0 2px rgba(10,10,14,0.9)',
        }}
      />
    )}
  </button>
);
