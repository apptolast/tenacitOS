import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { OPENCLAW_WORKSPACE, dataFile } from '@/lib/paths';
import { getActivities } from '@/lib/activities-db';

const WORKSPACE = OPENCLAW_WORKSPACE;
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

interface SearchResult {
  type: 'memory' | 'activity' | 'task';
  title: string;
  snippet: string;
  path?: string;
  timestamp?: string;
}

function searchInFile(filePath: string, query: string): SearchResult[] {
  const results: SearchResult[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const lowerQuery = query.toLowerCase();
    
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(lowerQuery)) {
        const start = Math.max(0, index - 1);
        const end = Math.min(lines.length, index + 2);
        const snippet = lines.slice(start, end).join('\n');
        
        results.push({
          type: 'memory',
          title: path.basename(filePath),
          snippet: snippet.substring(0, 200),
          path: filePath
        });
      }
    });
  } catch {
    // Skip files that can't be read
  }
  return results;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';
  
  if (!query || query.length < 2) {
    return NextResponse.json([]);
  }
  
  const results: SearchResult[] = [];
  
  // Search memory files
  const memoryFiles = [
    path.join(WORKSPACE, 'MEMORY.md'),
    ...(() => {
      try {
        return fs.readdirSync(MEMORY_DIR)
          .filter(f => f.endsWith('.md'))
          .map(f => path.join(MEMORY_DIR, f));
      } catch {
        return [];
      }
    })()
  ];
  
  for (const file of memoryFiles) {
    results.push(...searchInFile(file, query));
  }
  
  // Search activities via SQLite (PVC-persistent)
  try {
    const lowerQuery = query.toLowerCase();
    const { activities } = getActivities({ limit: 100 });
    for (const activity of activities) {
      if (
        activity.description?.toLowerCase().includes(lowerQuery) ||
        activity.type?.toLowerCase().includes(lowerQuery)
      ) {
        results.push({
          type: 'activity',
          title: activity.type,
          snippet: activity.description,
          timestamp: activity.timestamp,
        });
      }
    }
  } catch {
    // Skip if can't read
  }

  // Search tasks (kept as a JSON file for now; path resolved via TENACITOS_DATA_DIR)
  try {
    const tasksPath = dataFile('tasks.json');
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
    const lowerQuery = query.toLowerCase();
    for (const task of tasks) {
      if (
        task.name?.toLowerCase().includes(lowerQuery) ||
        task.description?.toLowerCase().includes(lowerQuery)
      ) {
        results.push({
          type: 'task',
          title: task.name,
          snippet: task.description,
          timestamp: task.nextRun,
        });
      }
    }
  } catch {
    // Skip if can't read
  }
  
  return NextResponse.json(results.slice(0, 20));
}
