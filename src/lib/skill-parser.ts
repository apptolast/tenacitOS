import fs from 'fs';
import path from 'path';
import { OPENCLAW_CONFIG, OPENCLAW_DIR } from './paths';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  location: string;
  source: 'workspace' | 'system';
  homepage?: string;
  emoji?: string;
  fileCount: number;
  fullContent: string;
  files: string[];
  agents: string[];
}

interface FrontMatter {
  name?: string;
  description?: string;
  homepage?: string;
  metadata?: { openclaw?: { emoji?: string } };
}

function parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { frontMatter: {}, body: content };
  const yaml = m[1];
  const body = m[2];
  const fm: FrontMatter = {};
  const name = yaml.match(/^name:\s*(.+)$/m);
  if (name) fm.name = name[1].trim();
  const desc = yaml.match(/^description:\s*(.+)$/m);
  if (desc) fm.description = desc[1].trim();
  const hp = yaml.match(/^homepage:\s*(.+)$/m);
  if (hp) fm.homepage = hp[1].trim();
  const em = yaml.match(/"emoji":\s*"([^"]+)"/);
  if (em) fm.metadata = { openclaw: { emoji: em[1] } };
  return { frontMatter: fm, body };
}

function extractFirstParagraph(body: string): string {
  const lines = body.split('\n');
  let inPara = false;
  let para = '';
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#')) {
      if (inPara) break;
      continue;
    }
    if (!t && !inPara) continue;
    if (t && !inPara) {
      inPara = true;
      para = t;
      continue;
    }
    if (t && inPara) {
      para += ' ' + t;
      continue;
    }
    if (!t && inPara) break;
  }
  return para || 'No description available';
}

function countFiles(skillPath: string): { count: number; files: string[] } {
  try {
    const files: string[] = [];
    const scan = (dir: string, prefix = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) scan(path.join(dir, e.name), rel);
        else files.push(rel);
      }
    };
    scan(skillPath);
    return { count: files.length, files };
  } catch {
    return { count: 0, files: [] };
  }
}

export function parseSkill(skillPath: string, skillName: string, agents: string[] = []): SkillInfo | null {
  const skillMd = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  try {
    const content = fs.readFileSync(skillMd, 'utf-8');
    const { frontMatter, body } = parseFrontMatter(content);
    const { count, files } = countFiles(skillPath);
    const source: 'workspace' | 'system' = skillPath.includes('/workspace') ? 'workspace' : 'system';
    return {
      id: skillName,
      name: frontMatter.name || skillName,
      description: frontMatter.description || extractFirstParagraph(body),
      location: skillPath,
      source,
      homepage: frontMatter.homepage,
      emoji: frontMatter.metadata?.openclaw?.emoji,
      fileCount: count,
      fullContent: content,
      files,
      agents,
    };
  } catch {
    return null;
  }
}

/**
 * Auto-discover skills by scanning every agent's workspace `skills/` directory.
 * Aggregates by skill name, collecting the list of agents that have each.
 */
export function scanAllSkills(): SkillInfo[] {
  const byName = new Map<string, { info: SkillInfo; agents: Set<string> }>();

  let agentList: Array<{ id: string; workspace: string }> = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    agentList = (cfg?.agents?.list || []).map((a: { id: string; workspace?: string }) => ({
      id: a.id,
      workspace: a.workspace || path.join(OPENCLAW_DIR, 'workspace'),
    }));
    // Also include the default workspace (main agent)
    if (!agentList.find((a) => a.id === 'main')) {
      agentList.push({ id: 'main', workspace: path.join(OPENCLAW_DIR, 'workspace') });
    }
  } catch {
    // Fallback: scan workspace-* directories directly
    try {
      for (const e of fs.readdirSync(OPENCLAW_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || !e.name.startsWith('workspace')) continue;
        const id = e.name === 'workspace' ? 'main' : e.name.replace('workspace-', '');
        agentList.push({ id, workspace: path.join(OPENCLAW_DIR, e.name) });
      }
    } catch {}
  }

  for (const { id, workspace } of agentList) {
    const skillsDir = path.join(workspace, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const skillName of entries) {
      const skillPath = path.join(skillsDir, skillName);
      const skill = parseSkill(skillPath, skillName);
      if (!skill) continue;
      const existing = byName.get(skillName);
      if (existing) {
        existing.agents.add(id);
      } else {
        byName.set(skillName, { info: skill, agents: new Set([id]) });
      }
    }
  }

  // Merge system skills dir if it exists (openclaw bundled skills)
  const systemSkillsDir = path.join(OPENCLAW_DIR, 'skills');
  if (fs.existsSync(systemSkillsDir)) {
    try {
      for (const e of fs.readdirSync(systemSkillsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const skillPath = path.join(systemSkillsDir, e.name);
        const skill = parseSkill(skillPath, e.name);
        if (!skill) continue;
        const existing = byName.get(e.name);
        if (existing) existing.agents.add('system');
        else byName.set(e.name, { info: skill, agents: new Set(['system']) });
      }
    } catch {}
  }

  const skills: SkillInfo[] = [];
  for (const { info, agents } of byName.values()) {
    skills.push({ ...info, agents: Array.from(agents).sort() });
  }
  skills.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return skills;
}
