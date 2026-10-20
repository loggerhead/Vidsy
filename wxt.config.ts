import { defineConfig } from 'wxt';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WXT's isolated W1 shell. It writes only to `.output/`, leaving the frozen
 * legacy `dist/` baseline available for the manifest and asset comparison in W2.
 */
export default defineConfig({
  imports: false,
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  publicDir: 'chrome-extension/public',
  vite: () => ({
    // WXT builds entrypoints directly; workspace package dist/ files may be
    // stale after a source edit. Resolve runtime contracts from source.
    resolve: {
      alias: {
        '@extension/shared': resolve('packages/shared/index.mts'),
        '@extension/storage': resolve('packages/storage/index.mts'),
      },
    },
    plugins: [
      {
        name: 'vidsy-page-src-alias',
        resolveId(source, importer) {
          if (!importer || !source.startsWith('@src/')) return null;
          const marker = '/src/';
          const index = importer.lastIndexOf(marker);
          if (index === -1) return null;
          const path = resolve(importer.slice(0, index + marker.length), source.slice('@src/'.length));
          return (
            [
              path,
              `${path}.ts`,
              `${path}.tsx`,
              `${path}.js`,
              `${path}.jsx`,
              resolve(path, 'index.ts'),
              resolve(path, 'index.tsx'),
            ].find(existsSync) ?? null
          );
        },
      },
    ],
  }),
  manifest: {
    default_locale: 'en',
    name: '__MSG_extensionName__',
    version: '1.1.0',
    description: '__MSG_extensionDescription__',
    browser_specific_settings: { gecko: { id: 'example@example.com', strict_min_version: '109.0' } },
    host_permissions: ['<all_urls>'],
    permissions: [
      'alarms',
      'storage',
      'scripting',
      'tabs',
      'webNavigation',
      'sidePanel',
      'downloads',
      'webRequest',
      'declarativeNetRequest',
      'declarativeNetRequestWithHostAccess',
      'offscreen',
      'contextMenus',
      'unlimitedStorage',
    ],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    cross_origin_embedder_policy: { value: 'require-corp' },
    cross_origin_opener_policy: { value: 'same-origin' },
    icons: { '128': 'icon-128.png' },
    side_panel: { default_path: 'side-panel.html' },
    web_accessible_resources: [
      { resources: ['*.js', '*.css', '*.svg', 'icon-128.png', 'icon-34.png'], matches: ['*://*/*'] },
    ],
    commands: {
      'activate-picker': {
        suggested_key: { default: 'Alt+Shift+V', mac: 'Alt+Shift+V' },
        description: 'Pick a video on the current page',
      },
    },
  },
});
