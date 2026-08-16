describe('Webextension Side Panel', () => {
  it('should make side panel accessible', async () => {
    const extensionPath = await browser.getExtensionPath();
    const sidePanelUrl = `${extensionPath}/side-panel.html`;

    await browser.url(sidePanelUrl);
    await expect(browser).toHaveTitle('Side Panel');
    await expect($('#app-container > *')).toBeExisting();
  });
});
