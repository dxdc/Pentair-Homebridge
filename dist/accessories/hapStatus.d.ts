import type { HAP } from 'homebridge';
/** Cached state older than this (three missed polls) is reported to HomeKit as "No Response". */
export declare const STALE_AFTER_MS: number;
/** The error HomeKit shows as "No Response" / "Not Responding". */
export declare function communicationFailure(hap: HAP): Error;
