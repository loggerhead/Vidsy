describe('Webextension Options Page', () => {
  it('should make options page accessible', async () => {
    const extensionPath = await browser.getExtensionPath();
    const optionsUrl = `${extensionPath}/options.html`;

    await browser.url(optionsUrl);

    await expect(browser).toHaveTitle('Options');
    await expect($('#app-container > *')).toBeExisting();
  });
});
