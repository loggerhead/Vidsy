import { canSwitchTheme } from '../helpers/theme.js';

describe('Webextension New Tab', () => {
  it('should open the extension page when a new tab is opened', async () => {
    const extensionPath = await browser.getExtensionPath();
    // WXT emits this as a regular extension page; the production manifest does
    // not override Chrome's built-in new-tab page.
    const newTabUrl = `${extensionPath}/new-tab.html`;

    await browser.url(newTabUrl);

    const appDiv = await $('.App').getElement();
    await expect(appDiv).toBeExisting();
    await canSwitchTheme();
  });
});
