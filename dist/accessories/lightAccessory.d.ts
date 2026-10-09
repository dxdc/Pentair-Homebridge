/**
 * PentairLightAccessory – HomeKit accessory for a Pentair IntelliBrite color light.
 *
 * HomeKit service: Lightbulb with the following characteristics:
 *  - On         → light on / off   (cloud field: lse)
 *  - Hue        → 0–360°           (cloud field: lco, Pentair color index)
 *  - Saturation → 0–100 %          (used to detect "white" mode: < 20% → White)
 *
 * Hue → Pentair color index mapping:
 *  0–20 or 340–360 → Red      (4)
 *  21–60           → Party    (5)   orange/warm range
 *  61–150          → Green    (3)
 *  151–200         → Caribbean(7)   teal
 *  201–260         → Blue     (2)
 *  261–290         → Romance  (6)   purple
 *  291–339         → Magenta  (1)
 *  Saturation < 20%→ White    (0)   (overrides hue)
 *
 * Cloud API payload fields:
 *  lse  – light on/off ("1" / "0")
 *  lco  – color index as string
 */
import type { PlatformAccessory } from 'homebridge';
import type { PentairHomebridgePlatform } from '../platform';
import type { PentairApi } from '../pentairApi';
/** Configuration block expected under `config.light`. */
export interface LightConfig {
    deviceId: string;
    name: string;
}
/**
 * Pentair PLC1 v2 API color indices (field d1).
 * Values match what the device reports and what sendCommand should send.
 */
export declare const enum PentairColor {
    SAM = 1,
    Party = 2,
    Romance = 3,
    Caribbean = 4,
    American = 5,
    Sunset = 6,
    Royal = 7,
    Blue = 8,
    Green = 9,
    Red = 10,
    White = 11,
    Magenta = 12
}
/**
 * Homebridge accessory that bridges a Pentair IntelliBrite light to HomeKit.
 *
 * Registered and restored by `PentairHomebridgePlatform.discoverDevices()`.
 */
export declare class PentairLightAccessory {
    private readonly service;
    private readonly api;
    private readonly deviceId;
    private readonly platform;
    private readonly accessory;
    /** Locally cached state to avoid redundant cloud round-trips. */
    private state;
    /** Derived hue/saturation so HomeKit reads are consistent with color index. */
    private hue;
    private saturation;
    private pollHandle;
    /** When the cached state was last confirmed by the cloud (starts as a grace period). */
    private lastPollOk;
    constructor(platform: PentairHomebridgePlatform, accessory: PlatformAccessory, api: PentairApi, config: LightConfig);
    private handleOnGet;
    private handleOnSet;
    private handleHueGet;
    private handleHueSet;
    private handleSaturationGet;
    private handleSaturationSet;
    /**
     * Hue and saturation arrive as separate writes, often together, so they are
     * debounced into one command. Every caller in the window waits on that one
     * command, so a failure is reported back to HomeKit instead of only logged.
     */
    private colorDebounce;
    private colorWaiters;
    private scheduleColorChange;
    private assertFresh;
    /**
     * Derives the Pentair color index from the current hue/saturation and sends
     * the `lco` command to the cloud API.
     */
    private applyColorChange;
    private startPolling;
    /**
     * Fetches device status and propagates changes to HomeKit characteristics.
     */
    private pollStatus;
}
