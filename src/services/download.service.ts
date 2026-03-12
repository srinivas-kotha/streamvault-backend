import { existsSync, unlinkSync } from 'fs';
import { query } from './db.service';

interface DownloadingRow {
  id: number;
  file_path: string | null;
}

export async function recoverDownloadQueue(): Promise<void> {
  // Find downloads that were mid-flight when the server stopped
  const result = await query<DownloadingRow>(
    `SELECT id, file_path FROM sv_downloads WHERE status = 'downloading'`
  );

  if (result.rows.length === 0) {
    console.log('[download] No interrupted downloads to recover');
    return;
  }

  console.log(`[download] Recovering ${result.rows.length} interrupted download(s)`);

  // Delete partial files
  for (const row of result.rows) {
    if (row.file_path && existsSync(row.file_path)) {
      try {
        unlinkSync(row.file_path);
        console.log(`[download] Deleted partial file: ${row.file_path}`);
      } catch (err) {
        console.error(`[download] Failed to delete ${row.file_path}:`, (err as Error).message);
      }
    }
  }

  // Reset all downloading entries back to queued
  await query(
    `UPDATE sv_downloads
     SET status = 'queued', error_message = 'Reset after restart', progress_percent = 0
     WHERE status = 'downloading'`
  );

  console.log(`[download] Reset ${result.rows.length} download(s) to queued`);
}
