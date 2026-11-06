const BROWSER_CONTROLLED_HEADERS = new Set(['cookie', 'origin', 'referer']);

const HEADER_ORIGIN = '__vidsy_source_origin';
const scopeHeaders = (headers: Record<string, string> | undefined, url: string): Record<string, string> | undefined =>
  headers && { ...headers, [HEADER_ORIGIN]: new URL(url).origin };

const headersForFetch = (headers?: Record<string, string>, targetUrl?: string): Record<string, string> => {
  const sourceOrigin = headers?.[HEADER_ORIGIN];
  const sameOrigin = !sourceOrigin || (!!targetUrl && new URL(targetUrl).origin === sourceOrigin);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const lower = name.toLowerCase();
      if (name === HEADER_ORIGIN || BROWSER_CONTROLLED_HEADERS.has(lower) || lower.startsWith('sec-fetch-'))
        return false;
      return sameOrigin || ['accept', 'accept-language', 'user-agent'].includes(lower);
    }),
  );
};

export { headersForFetch, scopeHeaders };
