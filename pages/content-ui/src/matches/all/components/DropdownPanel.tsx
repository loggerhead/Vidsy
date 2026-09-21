import { IcoDown } from './icons';
import { GLASS_PANEL, GLASS_BORDER, BLUR, TEXT, MUTED, HOVER } from './tokens';
import { formatSeconds } from '../lib/media-helpers';
import type { MediaItem, MediaVariant } from '@extension/shared';

type Row = { sub: string; item: MediaItem; variant?: MediaVariant };

export const DropdownPanel = ({
  rows,
  primary,
  bestVariant,
  onDownload,
}: {
  rows: Row[];
  primary: MediaItem;
  bestVariant?: MediaVariant;
  onDownload: (item: MediaItem, variant?: MediaVariant) => void;
}) => (
  <div
    style={{
      position: 'absolute',
      top: '100%',
      right: 0,
      background: GLASS_PANEL,
      backdropFilter: BLUR,
      WebkitBackdropFilter: BLUR,
      border: `1px solid ${GLASS_BORDER}`,
      borderRadius: 10,
      overflow: 'hidden',
      minWidth: 280,
      maxWidth: 300,
      boxShadow: '0 10px 28px rgba(0,0,0,0.6)',
    }}>
    {/* Best quality shortcut, labelled with the video metadata. */}
    <button
      onClick={() => onDownload(primary, bestVariant)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: 'rgba(255,255,255,0.05)',
        border: 'none',
        borderBottom: `1px solid ${GLASS_BORDER}`,
        padding: '7px 12px',
        cursor: 'pointer',
        textAlign: 'left',
        color: TEXT,
        fontSize: 11,
        fontWeight: 700,
      }}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)')}>
      <IcoDown />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {primary.title ?? primary.fileName ?? 'Video'}
      </span>
      <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 10, flexShrink: 0 }}>
        {formatSeconds(primary.duration)}
      </span>
    </button>

    {/* Quality rows */}
    {rows.map((row, idx) => {
      const [quality, format, size] = row.sub.split(' · ');
      return (
        <button
          key={`${row.item.url}-${idx}`}
          onClick={() => onDownload(row.item, row.variant)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            background: 'none',
            border: 'none',
            borderBottom: idx < rows.length - 1 ? `1px solid rgba(255,255,255,0.06)` : 'none',
            padding: '8px 12px',
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}>
          {quality && (
            <span
              style={{
                color: TEXT,
                background: idx === 0 ? 'rgba(96,165,250,0.22)' : 'rgba(255,255,255,0.08)',
                borderRadius: 4,
                padding: '2px 5px',
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1.2,
              }}>
              {quality}
            </span>
          )}
          {format && <span style={{ color: 'rgba(255,255,255,0.72)', fontSize: 10, fontWeight: 600 }}>{format}</span>}
          {size && (
            <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
              {size}
            </span>
          )}
        </button>
      );
    })}
  </div>
);
