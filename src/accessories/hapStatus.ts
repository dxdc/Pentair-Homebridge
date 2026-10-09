import type { HAP } from 'homebridge';
import { STATUS_POLL_INTERVAL_MS } from '../settings';

/** Cached state older than this (three missed polls) is reported to HomeKit as "No Response". */
export const STALE_AFTER_MS = 3 * STATUS_POLL_INTERVAL_MS;

/** The error HomeKit shows as "No Response" / "Not Responding". */
export function communicationFailure(hap: HAP): Error {
  return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}
