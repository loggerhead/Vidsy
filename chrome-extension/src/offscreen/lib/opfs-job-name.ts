// A request ID is an opaque identity, never a filesystem path. Hashing keeps
// names bounded and prevents distinct punctuation/URL IDs from aliasing.
export const opfsJobName = async (kind: string, key: string, tag: string, extension: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const id = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${kind}-${id}-${tag}.${extension.replace(/^\./, '')}`;
};
