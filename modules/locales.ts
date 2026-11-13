import { defineWxtModule } from 'wxt/modules';
import { resolve } from 'node:path';

/** Preserve the existing locale ownership while placing it at WXT's MV3 path. */
export default defineWxtModule({
  setup(wxt) {
    wxt.logger.debug('Registering UUGet locale and page-logo public assets');
    wxt.hook('build:publicAssets', (_wxt, files) => {
      for (const locale of ['en', 'ko']) {
        files.unshift({
          absoluteSrc: resolve('packages/i18n/locales', locale, 'messages.json'),
          relativeDest: `_locales/${locale}/messages.json`,
        });
      }
      for (const [page, filesForPage] of Object.entries({
        'devtools-panel': ['logo_horizontal.svg', 'logo_horizontal_dark.svg'],
        'new-tab': ['logo_horizontal.svg', 'logo_horizontal_dark.svg'],
        options: ['logo_horizontal.svg', 'logo_horizontal_dark.svg'],
        popup: ['logo_vertical.svg', 'logo_vertical_dark.svg'],
        'side-panel': ['logo_vertical.svg', 'logo_vertical_dark.svg'],
      })) {
        for (const file of filesForPage) {
          files.unshift({
            absoluteSrc: resolve('pages', page, 'public', file),
            relativeDest: `${page}/${file}`,
          });
        }
      }
    });
  },
});
