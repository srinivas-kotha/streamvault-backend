import { spawn, execSync, ChildProcess } from 'child_process';

const trackedPids = new Set<number>();

export function spawnFFmpeg(args: string[]): ChildProcess {
  const proc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (proc.pid !== undefined) {
    trackedPids.add(proc.pid);

    proc.on('exit', () => {
      trackedPids.delete(proc.pid!);
    });

    proc.on('error', () => {
      trackedPids.delete(proc.pid!);
    });
  }

  return proc;
}

export function killAllFFmpeg(): void {
  // Kill tracked processes first
  for (const pid of trackedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may have already exited
    }
  }
  trackedPids.clear();

  // Safety net: kill any orphaned ffmpeg processes related to streamvault
  try {
    execSync('pkill -f "ffmpeg.*streamvault"', { timeout: 5000 });
  } catch {
    // pkill returns non-zero if no processes matched — expected
  }
}

export function getActiveFFmpegCount(): number {
  return trackedPids.size;
}
