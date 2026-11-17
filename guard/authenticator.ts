// Evaluated by the Playwright MCP server on every new page, before the first navigation.
// Adds a virtual authenticator: a page that asks for a passkey or security key gets an answer from
// this empty software device instead of opening a Windows Hello / Touch ID / USB-key prompt on the
// person's screen. It holds no credentials, so it can sign nobody in.
export default async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable');
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: false, automaticPresenceSimulation: false },
  });
};
