/**
 * Glob pattern matching for file paths.
 *
 * Supported patterns:
 * - `*`  matches any characters except `/`
 * - `**` matches any characters including `/` (recursive directory match)
 * - `?`  matches a single character (not `/`)
 * - All other characters are matched literally
 * - Special regex characters are escaped
 */

/**
 * Test whether a path matches a glob pattern.
 *
 * @param pattern - Glob pattern (e.g., `**\/*.test.efs`)
 * @param path - File path to test against the pattern
 * @returns true if the path matches the pattern
 */
export function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

/**
 * Convert a glob pattern to a RegExp.
 */
export function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // ** — match anything including /
        // Skip any trailing / after **
        i += 2;
        if (i < pattern.length && pattern[i] === '/') {
          i++;
          // **/ matches zero or more directory segments
          regex += '(?:.*/)?';
        } else {
          regex += '.*';
        }
      } else {
        // * — match anything except /
        regex += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      // ? — match single char except /
      regex += '[^/]';
      i++;
    } else {
      // Escape special regex characters
      regex += escapeRegexChar(ch);
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

function escapeRegexChar(ch: string): string {
  if ('\\^$.|+()[]{}?*'.includes(ch)) {
    return '\\' + ch;
  }
  return ch;
}
