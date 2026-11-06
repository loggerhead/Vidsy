import { IcoDown, IcoX } from './icons';
import { groupDownloadOptions, recommendDownloadOption } from '../lib/download-options';
import { formatSeconds } from '../lib/media-helpers';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DownloadOption, DownloadRow } from '../lib/download-options';
import type { MediaItem, MediaVariant } from '@extension/shared';

export const DropdownPanel = ({
  rows,
  primary,
  onDownload,
  onClose,
}: {
  rows: DownloadRow[];
  primary: MediaItem;
  onDownload: (item: MediaItem, variant?: MediaVariant) => void;
  onClose: () => void;
}) => {
  const groups = useMemo(() => groupDownloadOptions(rows), [rows]);
  const recommended = recommendDownloadOption(groups);
  const [selectedKey, setSelectedKey] = useState(recommended?.key);
  const [expandedQualities, setExpandedQualities] = useState<string[]>([]);
  const selected = groups.flatMap(group => group.options).find(option => option.key === selectedKey) ?? recommended;
  const titleId = useId();
  const radioName = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('input:checked') ?? panel?.querySelector('button'))?.focus({
      preventScroll: true,
    });
  }, []);

  const renderOption = (option: DownloadOption, isAlternative = false, version?: number) => (
    <label
      key={option.key}
      htmlFor={`${radioName}-${option.key}`}
      aria-label={`${option.quality}, ${option.details}, ${option.size}`}
      className={isAlternative ? 'vidsy-option vidsy-option-alternative' : 'vidsy-option'}>
      <input
        id={`${radioName}-${option.key}`}
        type="radio"
        name={radioName}
        checked={selected?.key === option.key}
        disabled={option.blocked}
        onChange={() => setSelectedKey(option.key)}
      />
      <span className="vidsy-option-copy">
        <span className="vidsy-option-heading">
          <span className="vidsy-option-quality">{isAlternative ? `Version ${version}` : option.quality}</span>
          <span className="vidsy-option-details" title={option.details}>
            {option.details}
            {option.blocked ? ' · Unavailable' : ''}
          </span>
          <span className="vidsy-option-size">{option.size}</span>
        </span>
      </span>
    </label>
  );

  return (
    <div ref={panelRef} className="vidsy-download-panel" role="dialog" aria-labelledby={titleId}>
      <header className="vidsy-panel-header">
        <div>
          <h2 id={titleId}>Download video</h2>
          <p title={primary.title ?? primary.fileName}>{primary.title ?? primary.fileName ?? 'Current video'}</p>
          {primary.duration ? <span className="vidsy-duration">{formatSeconds(primary.duration)}</span> : null}
        </div>
        <button type="button" className="vidsy-close" onClick={onClose} aria-label="Close download options">
          <IcoX />
        </button>
      </header>
      <div className="vidsy-quality-list" role="group" aria-label="Video quality">
        {groups.map(group => {
          const active = group.options.find(option => option.key === selected?.key);
          const expanded = expandedQualities.includes(group.quality);
          const representative = (expanded ? undefined : active) ?? group.options[0];
          return (
            <div key={group.options[0].key} className="vidsy-quality-group">
              {renderOption(representative)}
              {group.options.length > 1 && (
                <>
                  <button
                    type="button"
                    className="vidsy-more-versions"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedQualities(previous =>
                        expanded ? previous.filter(quality => quality !== group.quality) : [...previous, group.quality],
                      )
                    }>
                    {expanded ? 'Hide other versions' : `${group.options.length - 1} other versions`}
                    <span aria-hidden="true">{expanded ? '−' : '+'}</span>
                  </button>
                  {expanded &&
                    group.options
                      .filter(option => option.key !== representative.key)
                      .map(option => renderOption(option, true, group.options.indexOf(option) + 1))}
                </>
              )}
            </div>
          );
        })}
      </div>
      <footer className="vidsy-panel-footer">
        <button
          type="button"
          className="vidsy-download-button"
          disabled={!selected || selected.blocked}
          onClick={() => selected && onDownload(selected.item, selected.variant)}>
          <IcoDown /> Download
        </button>
      </footer>
    </div>
  );
};
