import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { dataFile, ensureDataDir } from './paths';

const DATA_PATH = dataFile('activities.json');
ensureDataDir();

export type ActivityType = 
  | 'file' 
  | 'search' 
  | 'message' 
  | 'command' 
  | 'security' 
  | 'build' 
  | 'task' 
  | 'cron' 
  | 'memory';

export type ActivityStatus = 'success' | 'error' | 'pending';

export interface ActivityMetadata {
  [key: string]: unknown;
}

export interface Activity {
  id: string;
  timestamp: string;
  type: ActivityType;
  description: string;
  status: ActivityStatus;
  duration_ms: number | null;
  tokens_used: number | null;
  metadata: ActivityMetadata | null;
}

export interface LogActivityOptions {
  duration_ms?: number | null;
  tokens_used?: number | null;
  metadata?: ActivityMetadata | null;
}

/**
 * Logs an activity to the activities.json file
 * @param type - The type of activity (file, search, message, etc.)
 * @param description - Human-readable description of the activity
 * @param status - The status of the activity (success, error, pending)
 * @param options - Optional fields: duration_ms, tokens_used, metadata
 * @returns The created activity object
 */
export function logActivity(
  type: ActivityType,
  description: string,
  status: ActivityStatus,
  options?: LogActivityOptions
): Activity {
  // Data dir is guaranteed by the module-level ensureDataDir() call.

  // Read existing activities
  let activities: Activity[] = [];
  try {
    const data = fs.readFileSync(DATA_PATH, 'utf-8');
    activities = JSON.parse(data);
  } catch {
    // File doesn't exist or is invalid, start fresh
    activities = [];
  }

  // Create new activity
  const newActivity: Activity = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    description,
    status,
    duration_ms: options?.duration_ms ?? null,
    tokens_used: options?.tokens_used ?? null,
    metadata: options?.metadata ?? null,
  };

  // Prepend to array (newest first)
  activities.unshift(newActivity);

  // Write back to file
  fs.writeFileSync(DATA_PATH, JSON.stringify(activities, null, 2));

  return newActivity;
}

/**
 * Read all activities from the file
 */
export function getActivities(): Activity[] {
  try {
    const data = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Update an existing activity's status
 */
export function updateActivityStatus(
  id: string,
  status: ActivityStatus,
  options?: { duration_ms?: number; tokens_used?: number }
): Activity | null {
  const activities = getActivities();
  const index = activities.findIndex((a) => a.id === id);
  
  if (index === -1) return null;

  activities[index] = {
    ...activities[index],
    status,
    duration_ms: options?.duration_ms ?? activities[index].duration_ms,
    tokens_used: options?.tokens_used ?? activities[index].tokens_used,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(activities, null, 2));
  return activities[index];
}
