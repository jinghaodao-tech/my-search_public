import { startScheduler } from '../collector.js';

export function createSchedulerService() {
  let schedulerStop: (() => void) | null = null;
  let schedulerCronExpr: string | null = null;
  let collectRunning = false;

  return {
    startScheduler,
    getSchedulerStop: () => schedulerStop,
    setSchedulerStop: (value: (() => void) | null) => { schedulerStop = value; },
    getSchedulerCronExpr: () => schedulerCronExpr,
    setSchedulerCronExpr: (value: string | null) => { schedulerCronExpr = value; },
    getCollectRunning: () => collectRunning,
    setCollectRunning: (value: boolean) => { collectRunning = value; },
  };
}