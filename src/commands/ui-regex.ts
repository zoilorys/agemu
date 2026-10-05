/**
 * Portable assertText regex: Unicode characters, dot, anchors, character classes, alternation,
 * capturing/noncapturing groups and greedy/lazy quantifiers (repeat counts up to 16777215). No flags, backreferences, lookaround,
 * named groups, Unicode properties or class-set operations. Shorthands use ASCII d/w/s (space,
 * tab, LF, CR, FF, VT); dot excludes LF, CR, U+2028 and U+2029; $ means strict end of text.
 * Both engines match Unicode scalar values (JavaScript must use the `u` flag).
 */
export const portableRegexDescription = 'Unicode scalar matching; dot, anchors, character classes/ASCII shorthands, groups, alternation and quantifiers; no flags, backreferences, lookaround, Unicode properties or class-set operations';

const shorthand: Record<string, string> = { d: '0-9', w: 'A-Za-z0-9_', s: ' \\t\\n\\r\\f\\x0b' };

/** Compile the accepted subset to a source understood identically by JavaScript/u and ICU. */
export function portableRegexSource(pattern: string): string {
  try { new RegExp(pattern, 'u'); } catch { throw new Error('assertText matches must be a valid regular expression'); }
  const unsupported = (): never => { throw new Error('assertText matches uses an unsupported regular expression feature; use the portable subset'); };
  let source = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      const escaped = pattern[++index];
      const lower = escaped.toLowerCase();
      if (shorthand[lower]) {
        if (inClass && escaped !== lower) unsupported();
        source += inClass ? shorthand[lower] : `[${escaped === lower ? '' : '^'}${shorthand[lower]}]`;
      } else if (escaped === 'v') source += '\\x0b';
      else if ('nrtf'.includes(escaped) || '^$\\.*+?()[]{}|/-'.includes(escaped)) source += `\\${escaped}`;
      else unsupported();
      continue;
    }
    if (inClass) {
      // ICU supports nested sets and set intersection; JavaScript/u does not.
      if (char === '[' || (char === '&' && pattern[index + 1] === '&') || (char === '-' && pattern[index + 1] === '-')) unsupported();
      if (char === ']') inClass = false;
      source += char;
      continue;
    }
    if (char === '[') {
      if (pattern[index + 1] === ']' || (pattern[index + 1] === '^' && pattern[index + 2] === ']')) unsupported();
      inClass = true;
    }
    if (char === '{') {
      const repeat = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index));
      if (repeat && repeat.slice(1).some(count => count !== undefined && Number(count) > 16_777_215)) unsupported();
    }
    if (char === '(' && pattern[index + 1] === '?' && pattern.slice(index + 1, index + 3) !== '?:') unsupported();
    source += char === '.' ? '[^\\n\\r\\u2028\\u2029]' : char === '$' ? '(?![\\s\\S])' : char;
  }
  return source;
}
