// Keep platform navigation inside the account's browser session. Never forward
// native app schemes to Windows (including stale third-party protocol handlers).
export function isBrowserNavigation(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'blob:'].includes(url.protocol)
      || (url.protocol === 'about:' && ['blank', 'srcdoc'].includes(url.pathname));
  } catch { return false; }
}

export function configureDouyinSession(accountSession) {
  accountSession.setPermissionCheckHandler((_contents, permission) => permission !== 'openExternal');
  accountSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission !== 'openExternal');
  });
}

export function guardDouyinNavigation(contents) {
  const preventExternal = (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    if (!isBrowserNavigation(url)) event.preventDefault();
  };
  contents.on('will-navigate', preventExternal);
  contents.on('will-frame-navigate', preventExternal);
  contents.on('will-redirect', preventExternal);
}
