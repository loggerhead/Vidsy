import { AboutPanel } from './components/AboutPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { LicensePanel } from './components/LicensePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { SkeletonFallback, ErrorFallback } from './components/SkeletonFallback';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn } from '@extension/ui';
import { useEffect, useState } from 'react';

type Tab = 'settings' | 'history' | 'license' | 'about';

const tabFromHash = (): Tab => {
  if (typeof window === 'undefined') return 'settings';
  const hash = window.location.hash.replace('#', '');
  return hash === 'history' || hash === 'license' || hash === 'about' ? hash : 'settings';
};

const Options = () => {
  const { isLight } = useStorage(exampleThemeStorage);
  const [activeTab, setActiveTab] = useState<Tab>(tabFromHash);

  // Deep links such as options.html#license (paywall "restore" and the
  // 402 upgrade button) must switch tabs without a reload.
  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const bg = isLight ? 'bg-gray-50' : 'bg-[#0c0d12]';
  const text = isLight ? 'text-gray-800' : 'text-gray-100';

  return (
    <div className={cn('flex min-h-screen font-sans antialiased', bg, text)}>
      <Sidebar isLight={isLight} activeTab={activeTab} setActiveTab={setActiveTab} />

      {/* Content */}
      <main className="ml-[220px] flex-1 px-10 py-8">
        <div className="mx-auto max-w-3xl">
          {activeTab === 'settings' && <SettingsPanel isLight={isLight} />}
          {activeTab === 'history' && <HistoryPanel isLight={isLight} />}
          {activeTab === 'license' && <LicensePanel isLight={isLight} />}
          {activeTab === 'about' && <AboutPanel isLight={isLight} />}
        </div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <SkeletonFallback />), ErrorFallback);
