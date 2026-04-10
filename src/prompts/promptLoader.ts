import path from 'path';
import fs from 'fs';

// User-editable overrides: stored in persistent data volume (/app/data/prompts/)
const dataDir = path.resolve(__dirname, '../../data');
const userPromptsDir = path.join(dataDir, 'prompts');

// Built-in defaults: copied from src/prompts/platforms/ during Docker build
const builtinDir = path.join(__dirname, '../prompts/platforms');

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

function getPromptFilenames(platform: string): string[] {
  if (platform === '8891') {
    return ['8891.md', 'post-helper.md'];
  }

  return [`${platform}.md`];
}

function readWithCache(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    const cached = cache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.content;
    const content = fs.readFileSync(filePath, 'utf-8');
    cache.set(filePath, { content, mtime });
    return content;
  } catch {
    return null;
  }
}

/** Load prompt for a platform. Checks user override first, then built-in file. */
export function loadPlatformPrompt(platform: string): string {
  const filenames = getPromptFilenames(platform);

  // 1. User override in data/prompts/ (persistent across rebuilds)
  for (const filename of filenames) {
    const userContent = readWithCache(path.join(userPromptsDir, filename));
    if (userContent !== null) return userContent;
  }

  // 2. Built-in default from dist/prompts/platforms/
  for (const filename of filenames) {
    const builtinContent = readWithCache(path.join(builtinDir, filename));
    if (builtinContent !== null) return builtinContent;
  }

  return '';
}

/** Save a user override for a platform prompt. */
export function savePlatformPrompt(platform: string, content: string): void {
  fs.mkdirSync(userPromptsDir, { recursive: true });
  const userPath = path.join(userPromptsDir, `${platform}.md`);
  fs.writeFileSync(userPath, content, 'utf-8');
  cache.delete(userPath);

  if (platform === '8891') {
    const legacyUserPath = path.join(userPromptsDir, 'post-helper.md');
    try {
      fs.unlinkSync(legacyUserPath);
      cache.delete(legacyUserPath);
    } catch {
      // Legacy override does not exist.
    }
  }
}

/** Reset a platform prompt to built-in default by removing the user override. */
export function resetPlatformPrompt(platform: string): void {
  for (const filename of getPromptFilenames(platform)) {
    const userPath = path.join(userPromptsDir, filename);
    try {
      fs.unlinkSync(userPath);
      cache.delete(userPath);
    } catch {
      // File doesn't exist — already at default.
    }
  }
}

/** Get the built-in (default) prompt for a platform, ignoring user overrides. */
export function getBuiltinPrompt(platform: string): string {
  for (const filename of getPromptFilenames(platform)) {
    const builtinContent = readWithCache(path.join(builtinDir, filename));
    if (builtinContent !== null) return builtinContent;
  }

  return '';
}
