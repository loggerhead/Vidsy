import { cn } from '@extension/ui';

export const AboutPanel = ({ isLight }: { isLight: boolean }) => {
  const label = isLight ? 'text-gray-800' : 'text-gray-100';
  const sub = isLight ? 'text-gray-400' : 'text-gray-500';
  const cardCls = cn(
    'rounded-2xl border p-6',
    isLight ? 'border-gray-200 bg-white shadow-sm' : 'border-white/[0.06] bg-white/[0.02]',
  );

  const features = [
    {
      icon: '🔍',
      title: 'Smart Detection',
      desc: 'Automatic media detection via network monitoring and DOM observation',
    },
    {
      icon: '📦',
      title: 'HLS/DASH Support',
      desc: 'OPFS-streamed segments with libav.js WebAssembly remuxing — multi-GB safe',
    },
    {
      icon: '🔒',
      title: 'CDN Compatibility',
      desc: 'Header injection via declarativeNetRequest for restricted CDN access',
    },
    { icon: '🏷️', title: 'Rich Metadata', desc: 'Smart title extraction from JSON-LD, OpenGraph, and meta tags' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className={cn('text-lg font-semibold', label)}>About</h2>
        <p className={cn('mt-1 text-sm', sub)}>UUGet v{chrome.runtime.getManifest().version}</p>
      </div>

      <div className={cardCls}>
        <div className="mb-6 flex items-center gap-4">
          <div
            className={cn(
              'flex h-14 w-14 items-center justify-center rounded-2xl text-2xl',
              isLight ? 'bg-blue-100' : 'bg-blue-500/10',
            )}>
            🎬
          </div>
          <div>
            <h3 className={cn('text-base font-bold', label)}>UUGet</h3>
            <p className={cn('text-sm', sub)}>Find videos on the web. Save them in one click.</p>
          </div>
        </div>

        <a
          href="https://uu0uu.com"
          target="_blank"
          rel="noopener noreferrer"
          className="mb-6 inline-block text-sm font-medium text-blue-500 hover:underline">
          uu0uu.com
        </a>

        <div className="grid grid-cols-2 gap-3">
          {features.map(f => (
            <div key={f.title} className={cn('rounded-xl p-4', isLight ? 'bg-gray-50' : 'bg-white/[0.02]')}>
              <span className="text-xl">{f.icon}</span>
              <p className={cn('mt-2 text-sm font-semibold', label)}>{f.title}</p>
              <p className={cn('mt-0.5 text-xs leading-relaxed', sub)}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <p className={cn('text-center text-xs', sub)}>Built with React + Vite + TypeScript + Tailwind CSS</p>
    </div>
  );
};
