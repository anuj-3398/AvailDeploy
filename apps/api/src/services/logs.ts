import { buildLogs } from '@avail/db';
import type { BuildLog } from '@avail/shared/types';
import { bus } from '../lib/bus.ts';

/** Per-deployment log sequence counters, kept in memory while building. */
const counters = new Map<string, number>();

/** Appends a build log line, persisting it and broadcasting it to listeners. */
export function appendLog(
  deploymentId: string,
  level: BuildLog['level'],
  text: string
): void {
  let seq = counters.get(deploymentId);
  if (seq === undefined) {
    seq = buildLogs.maxSeq(deploymentId) + 1;
  }
  counters.set(deploymentId, seq + 1);

  const line = text.length > 8000 ? `${text.slice(0, 8000)}… (truncated)` : text;
  buildLogs.append(deploymentId, level, line, seq);
  bus.publishLog({ deploymentId, seq, ts: Date.now(), level, text: line });
}

export function releaseLogCounter(deploymentId: string): void {
  counters.delete(deploymentId);
}

/** Log sink bound to one deployment, matching the builder's LogSink shape. */
export function logSink(deploymentId: string) {
  return (level: BuildLog['level'], text: string) =>
    appendLog(deploymentId, level, text);
}
