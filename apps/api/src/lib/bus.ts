import { EventEmitter } from 'node:events';
import type { BuildLog, Deployment } from '@avail/shared/types';

export interface LogEvent {
  deploymentId: string;
  seq: number;
  ts: number;
  level: BuildLog['level'];
  text: string;
}

export interface DeploymentEvent {
  deploymentId: string;
  projectId: string;
  state: Deployment['state'];
  deployment: Deployment;
}

/**
 * In-process pub/sub used to stream build logs and deployment state to
 * dashboard clients over SSE.
 */
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publishLog(event: LogEvent): void {
    this.emit(`log:${event.deploymentId}`, event);
    this.emit('log', event);
  }

  publishDeployment(event: DeploymentEvent): void {
    this.emit(`deployment:${event.deploymentId}`, event);
    this.emit(`project:${event.projectId}`, event);
    this.emit('deployment', event);
  }

  onLog(deploymentId: string, listener: (event: LogEvent) => void) {
    const channel = `log:${deploymentId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  onDeployment(deploymentId: string, listener: (event: DeploymentEvent) => void) {
    const channel = `deployment:${deploymentId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  onAnyDeployment(listener: (event: DeploymentEvent) => void) {
    this.on('deployment', listener);
    return () => this.off('deployment', listener);
  }
}

export const bus = new Bus();
