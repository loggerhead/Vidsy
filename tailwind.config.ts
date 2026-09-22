import { withUI } from '@extension/ui/with-ui';
import type { Config } from 'tailwindcss';

export default withUI({
  content: [
    './pages/devtools-panel/index.html',
    './pages/devtools-panel/src/**/*.{ts,tsx}',
    './pages/new-tab/index.html',
    './pages/new-tab/src/**/*.{ts,tsx}',
    './pages/options/index.html',
    './pages/options/src/**/*.{ts,tsx}',
    './pages/popup/index.html',
    './pages/popup/src/**/*.{ts,tsx}',
    './pages/side-panel/index.html',
    './pages/side-panel/src/**/*.{ts,tsx}',
    './packages/ui/lib/**/*.{ts,tsx}',
  ],
}) satisfies Config;
