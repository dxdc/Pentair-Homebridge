/**
 * PentairPumpAccessory – HomeKit accessory for a Pentair variable-speed pool pump.
 *
 * HomeKit service: Fan (v2) using the following characteristics:
 *  - Active        → whether the pump is running
 *  - RotationSpeed → 0–100 % mapped to pump programs 1–4
 *
 * Program mapping (speed → program):
 *  1 – 25 %  → Program 1
 *  26 – 50 % → Program 2
 *  51 – 75 % → Program 3
 *  76 – 100% → Program 4
 *
 * Cloud API payload format:
 *  Start program N: { "zp{N}e10": "3" }
 *  Stop  program N: { "zp{N}e10": "2" }
 */
import type { PlatformAccessory } from 'homebridge';
import type { PentairHomebridgePlatform } from '../platform';
import type { PentairApi } from '../pentairApi';
/** Configuration block expected under `config.pump`. */
export interface PumpConfig {
    deviceId: string;
    name: string;
}
/**
 * Homebridge accessory that bridges a Pentair variable-speed pump to HomeKit.
 *
 * The accessory is registered by `PentairHomebridgePlatform.discoverDevices()`
 * and restored across Homebridge restarts via the accessory cache.
 */
export declare class PentairPumpAccessory {
    private readonly service;
    private readonly api;
    private readonly deviceId;
    private readonly platform;
    private readonly accessory;
    /** Locally cached state to avoid redundant cloud calls. */
    private state;
    /** Handle for the polling interval so it can be cleared on teardown. */
    private pollHandle;
    /** When the cached state was last confirmed by the cloud (starts as a grace period). */
    private lastPollOk;
    constructor(platform: PentairHomebridgePlatform, accessory: PlatformAccessory, api: PentairApi, config: PumpConfig);
    /** Returns whether the pump is currently active. */
    private handleActiveGet;
    /**
     * Turns the pump on or off.
     * On: starts the currently selected program.
     * Off: stops all programs.
     */
    private handleActiveSet;
    /** Returns the last-polled rotation speed percentage. */
    private handleSpeedGet;
    /**
     * Changes the pump speed by selecting the appropriate program.
     * If the pump is off and a non-zero speed is requested, it is turned on.
     */
    private handleSpeedSet;
    private assertFresh;
    /** Sends the start command to the cloud API (d25=1 = Enabled). */
    private startProgram;
    /** Sends the stop command to the cloud API (d25=0 = OFF). */
    private stopAllPrograms;
    /** Starts the periodic status polling loop. */
    private startPolling;
    /**
     * Fetches device status from the cloud and updates HomeKit characteristics.
     * Failures are logged but do not throw, keeping the polling loop alive.
     */
    private pollStatus;
}
