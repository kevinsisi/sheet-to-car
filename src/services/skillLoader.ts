import fs from 'fs';
import path from 'path';

export interface LoadedSkill {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  sourcePath: string;
}

const skillCache = new Map<string, LoadedSkill>();

function getRepoRoot(): string {
  return path.resolve(__dirname, '../..');
}

function getSkillSearchRoots(): string[] {
  const repoRoot = getRepoRoot();
  const roots = [
    path.join(repoRoot, 'skills'),
  ];

  if (process.env.HOMEPROJECT_SKILLS_DIR) {
    roots.push(process.env.HOMEPROJECT_SKILLS_DIR);
  }

  return roots;
}

function collectSkillFiles(dirPath: string, found: string[]): void {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectSkillFiles(fullPath, found);
      continue;
    }

    if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push(fullPath);
    }
  }
}

function parseFrontmatter(raw: string): { metadata: Record<string, string>; content: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, content: raw.trim() };
  }

  const metadata: Record<string, string> = {};
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '---') {
      index += 1;
      break;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex > 0) {
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      metadata[key] = value;
    }

    index += 1;
  }

  return {
    metadata,
    content: lines.slice(index).join('\n').trim(),
  };
}

function loadSkillFromFile(filePath: string): LoadedSkill {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { metadata, content } = parseFrontmatter(raw);
  const name = metadata.name || path.basename(path.dirname(filePath));
  const description = metadata.description || '';
  const triggers = metadata.triggers
    ? metadata.triggers.split(',').map(part => part.trim()).filter(Boolean)
    : [];

  return {
    name,
    description,
    triggers,
    content,
    sourcePath: filePath,
  };
}

function ensureSkillCache(): void {
  if (skillCache.size > 0) return;

  const files: string[] = [];
  for (const root of getSkillSearchRoots()) {
    collectSkillFiles(root, files);
  }

  for (const filePath of files) {
    const skill = loadSkillFromFile(filePath);
    skillCache.set(skill.name, skill);
  }
}

export function getSkill(name: string): LoadedSkill | null {
  ensureSkillCache();
  return skillCache.get(name) || null;
}

export function getSkills(names: string[]): LoadedSkill[] {
  return names.map(name => getSkill(name)).filter((skill): skill is LoadedSkill => !!skill);
}

export function selectSkillsFor8891(): LoadedSkill[] {
  return getSkills(['8891-spec-inference']);
}

export function selectSkillsForChat(userMessage: string): LoadedSkill[] {
  const message = userMessage.toLowerCase();
  const shouldLoad8891 = ['8891', 'post-helper', 'json', '規格', '欄位'].some(keyword => message.includes(keyword));

  if (!shouldLoad8891) {
    return [];
  }

  return selectSkillsFor8891();
}
