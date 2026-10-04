/** Raised when a JSON object repeats a member name. Parsers disagree on which duplicate wins, so OAR rejects them. */
export class DuplicateKeyError extends SyntaxError {
  constructor(readonly key: string) {
    super(`Duplicate JSON key ${JSON.stringify(key)}`);
    this.name = 'DuplicateKeyError';
  }
}

/**
 * JSON.parse for manifests, proof files and backlinks: identical result, but any object with a repeated
 * member name (compared after unescaping) throws DuplicateKeyError. Malformed JSON throws SyntaxError as usual.
 */
export function parseJsonStrict(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // The text is valid JSON at this point, so a single scan that tracks one key set per open object suffices.
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        const keys = stack[stack.length - 1] as Set<string>;
        if (keys.has(key)) throw new DuplicateKeyError(key);
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (c === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (c === '[') {
      stack.push(null);
      expectKey = false;
    } else if (c === '}' || c === ']') {
      stack.pop();
      expectKey = false;
    } else if (c === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return value;
}
