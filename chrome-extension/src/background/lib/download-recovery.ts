// Chrome alarms survive MV3 worker suspension and run after machine wake.
export const AUTO_RECOVERY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const;
export const AUTO_RECOVERY_ALARM = 'uuget-download-auto-recovery';
export type AutomaticRecovery = { attempts: number; nextRetryAt: number; reason: string; exhausted?: boolean };
export const nextAutomaticRecovery = (attempts: number, now: number, reason: string): AutomaticRecovery | undefined => {
  const delay = AUTO_RECOVERY_DELAYS_MS[attempts];
  return delay === undefined ? undefined : { attempts, nextRetryAt: now + delay, reason };
};
