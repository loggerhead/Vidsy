import { IcoDown, IcoStop } from './icons';
import { GLASS, GLASS_BORDER, BLUR, TEXT, HOVER } from './tokens';
import { describeDownloadDetails } from '../lib/download-details';
import { describeProgress } from '../lib/media-helpers';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MediaDownloadProgress } from '@extension/shared';

export const PillBar = ({
  isBusy,
  prog,
  expanded,
  onExpand,
}: {
  isBusy: boolean;
  prog: MediaDownloadProgress | null;
  expanded: boolean;
  onExpand: () => void;
}) => {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltipId = useId();
  const details = useMemo(() => describeDownloadDetails(prog, isBusy), [prog, isBusy]);
  const showDetails = (hovered || focused) && !dismissed && !expanded;
  const enter = () => {
    clearTimeout(closeTimer.current);
    setHovered(true);
    setDismissed(false);
  };
  const leave = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), 180);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    setDismissed(false);
  }, [prog?.key]);
  useLayoutEffect(() => {
    if (!showDetails) return;
    const position = () => {
      const button = buttonRef.current,
        tooltip = tooltipRef.current;
      if (!button || !tooltip) return;
      const anchor = button.getBoundingClientRect();
      const width = tooltip.offsetWidth,
        height = tooltip.offsetHeight;
      const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
      const below = anchor.bottom + 8;
      const top =
        below + height <= window.innerHeight - 12
          ? below
          : Math.max(12, Math.min(anchor.top - height - 8, window.innerHeight - height - 12));
      tooltip.style.right = `${anchor.right - left - width}px`;
      tooltip.style.top = `${top - anchor.top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (tooltipRef.current) observer.observe(tooltipRef.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [showDetails, details]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={isBusy ? 'Show download progress' : 'Show download options'}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-describedby={showDetails ? tooltipId : undefined}
        onClick={onExpand}
        style={{
          position: 'relative',
          width: isBusy ? 74 : 30,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          padding: isBusy ? '0 7px' : 0,
          color: prog?.stage === 'failed' ? '#f87171' : prog?.stage === 'success' ? '#86efac' : TEXT,
          background: GLASS,
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          border: `1px solid ${GLASS_BORDER}`,
          borderRadius: 9,
          boxShadow: '0 4px 16px rgba(0,0,0,0.48)',
          cursor: 'pointer',
          transition: 'width 120ms ease',
        }}
        onMouseEnter={e => {
          enter();
          e.currentTarget.style.background = HOVER;
        }}
        onMouseLeave={e => {
          leave();
          e.currentTarget.style.background = GLASS;
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={event => {
          if (event.key === 'Escape' && showDetails) {
            setDismissed(true);
            event.stopPropagation();
          }
        }}>
        {isBusy && !['success', 'failed'].includes(prog?.stage ?? '') ? <IcoStop /> : <IcoDown />}
        {isBusy && (
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}>
            {describeProgress(prog ?? undefined)}
          </span>
        )}
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
      {showDetails && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="vidsy-status-tooltip"
          onMouseEnter={enter}
          onMouseLeave={leave}>
          <p className="vidsy-status-title" style={{ color: prog?.stage === 'failed' ? '#f87171' : '#f5f5f7' }}>
            {details.title}
          </p>
          <p className="vidsy-status-description">{details.description}</p>
          {details.facts.length > 0 && (
            <ul className="vidsy-status-facts">
              {details.facts.map(fact => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          )}
          {details.error && (
            <div className="vidsy-status-error">
              <p>Reason</p>
              <div>{details.error}</div>
            </div>
          )}
        </div>
      )}
    </>
  );
};
