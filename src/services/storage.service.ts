import { execSync } from 'child_process';
import { unlinkSync, existsSync } from 'fs';
import { config } from '../config';
import { query } from './db.service';

interface StorageUsage {
  usedGB: number;
  maxGB: number;
  percentUsed: number;
}

export function getStorageUsage(): StorageUsage {
  const { dataDir, maxStorageGB } = config.storage;
  let usedBytes = 0;

  try {
    if (existsSync(dataDir)) {
      const output = execSync(`du -sb "${dataDir}"`, { encoding: 'utf-8', timeout: 10000 });
      usedBytes = parseInt(output.split('\t')[0], 10) || 0;
    }
  } catch (err) {
    console.error('[storage] Failed to get directory size:', (err as Error).message);
  }

  const usedGB = usedBytes / (1024 * 1024 * 1024);
  const percentUsed = maxStorageGB > 0 ? (usedGB / maxStorageGB) * 100 : 0;

  return {
    usedGB: Math.round(usedGB * 100) / 100,
    maxGB: maxStorageGB,
    percentUsed: Math.round(percentUsed * 100) / 100,
  };
}

export function checkStorageAvailable(): boolean {
  const usage = getStorageUsage();
  return usage.percentUsed < 80;
}

interface CompletedDownloadRow {
  id: number;
  file_path: string | null;
  completed_at: Date | null;
}

export async function cleanupOldFiles(): Promise<number> {
  const usage = getStorageUsage();
  if (usage.percentUsed < 80) {
    return 0;
  }

  console.log(`[storage] Usage at ${usage.percentUsed}% — cleaning up old downloads`);

  const result = await query<CompletedDownloadRow>(
    `SELECT id, file_path, completed_at FROM sv_downloads
     WHERE status = 'completed'
     ORDER BY completed_at ASC NULLS FIRST`
  );

  let deletedCount = 0;

  for (const row of result.rows) {
    if (checkStorageAvailable()) {
      break;
    }

    if (row.file_path && existsSync(row.file_path)) {
      try {
        unlinkSync(row.file_path);
        console.log(`[storage] Deleted: ${row.file_path}`);
      } catch (err) {
        console.error(`[storage] Failed to delete ${row.file_path}:`, (err as Error).message);
      }
    }

    await query(
      `UPDATE sv_downloads SET status = 'cancelled', error_message = 'Removed to free disk space'
       WHERE id = $1`,
      [row.id]
    );

    deletedCount++;
  }

  if (deletedCount > 0) {
    console.log(`[storage] Cleaned up ${deletedCount} old downloads`);
  }

  return deletedCount;
}
