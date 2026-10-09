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

import type {
  PlatformAccessory,
  CharacteristicValue,
  Service,
} from 'homebridge';
import type { PentairHomebridgePlatform } from '../platform';
import type { PentairApi } from '../pentairApi';
import { STATUS_POLL_INTERVAL_MS } from '../settings';
import { STALE_AFTER_MS, communicationFailure } from './hapStatus';

/** Configuration block expected under `config.pump`. */
export interface PumpConfig {
  deviceId: string;
  name: string;
}

/** Maximum number of named program slots used for the HomeKit set direction. */
const PROGRAM_COUNT = 4;

/** IF31 max rated flow in 1/10-GPM units (120 GPM × 10). */
const GPM_MAX_UNITS = 1200;

/** IF31 max RPM. */
const RPM_MAX = 3450;

/**
 * Converts the live setpoint fields (s15=mode, s16=setpoint) to a HomeKit
 * RotationSpeed percentage (0–100).
 *
 * Modes observed in the API:
 *  1 = percentage (setpoint 0–100 directly)
 *  2 = flow/GPM (setpoint in 1/10-GPM, max 120 GPM = 1200 units)
 *  3 = RPM (setpoint in RPM, max 3450)
 */
function setpointToSpeed(mode: number, setpoint: number): number {
  if (setpoint <= 0) return 0;
  if (mode === 1) return Math.min(setpoint, 100);
  if (mode === 2) return Math.min(Math.round(setpoint / GPM_MAX_UNITS * 100), 100);
  if (mode === 3) return Math.min(Math.round(setpoint / RPM_MAX * 100), 100);
  return 0;
}

/**
 * Maps a HomeKit RotationSpeed percentage (1–100) to a pump program number
 * (1–4) for the write direction.
 */
function speedToProgram(speed: number): number {
  if (speed <= 25) return 1;
  if (speed <= 50) return 2;
  if (speed <= 75) return 3;
  return 4;
}

/**
 * Homebridge accessory that bridges a Pentair variable-speed pump to HomeKit.
 *
 * The accessory is registered by `PentairHomebridgePlatform.discoverDevices()`
 * and restored across Homebridge restarts via the accessory cache.
 */
export class PentairPumpAccessory {
  private readonly service: Service;
  private readonly api: PentairApi;
  private readonly deviceId: string;
  private readonly platform: PentairHomebridgePlatform;
  private readonly accessory: PlatformAccessory;

  /** Locally cached state to avoid redundant cloud calls. */
  private state = {
    active: false,
    program: 1,
    speedPct: 0,
  };

  /** Handle for the polling interval so it can be cleared on teardown. */
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /** When the cached state was last confirmed by the cloud (starts as a grace period). */
  private lastPollOk = Date.now();

  constructor(
    platform: PentairHomebridgePlatform,
    accessory: PlatformAccessory,
    api: PentairApi,
    config: PumpConfig,
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.api = api;
    this.deviceId = config.deviceId;

    const { Service: Svc, Characteristic: Char } = this.platform.hapApi.hap;

    // ---------------------------------------------------------------------------
    // Accessory information service
    // ---------------------------------------------------------------------------
    this.accessory
      .getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Pentair')
      .setCharacteristic(Char.Model, 'Variable Speed Pump')
      .setCharacteristic(Char.SerialNumber, config.deviceId);

    // ---------------------------------------------------------------------------
    // Fan service
    // ---------------------------------------------------------------------------
    this.service =
      this.accessory.getService(Svc.Fanv2) ??
      this.accessory.addService(Svc.Fanv2, config.name);

    // Active (on / off)
    this.service
      .getCharacteristic(Char.Active)
      .onGet(this.handleActiveGet.bind(this))
      .onSet(this.handleActiveSet.bind(this));

    // RotationSpeed (0–100 %)
    this.service
      .getCharacteristic(Char.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.handleSpeedGet.bind(this))
      .onSet(this.handleSpeedSet.bind(this));

    // Begin polling.
    this.startPolling();
  }

  // ---------------------------------------------------------------------------
  // HomeKit characteristic handlers
  // ---------------------------------------------------------------------------

  /** Returns whether the pump is currently active. */
  private handleActiveGet(): CharacteristicValue {
    this.assertFresh();
    return this.state.active
      ? this.platform.hapApi.hap.Characteristic.Active.ACTIVE
      : this.platform.hapApi.hap.Characteristic.Active.INACTIVE;
  }

  /**
   * Turns the pump on or off.
   * On: starts the currently selected program.
   * Off: stops all programs.
   */
  private async handleActiveSet(value: CharacteristicValue): Promise<void> {
    const wantActive = value === this.platform.hapApi.hap.Characteristic.Active.ACTIVE;
    this.platform.log.info(
      `Pump [${this.deviceId}]: set active → ${wantActive}`,
    );

    const prevActive = this.state.active;
    const prevSpeedPct = this.state.speedPct;
    try {
      if (wantActive) {
        await this.startProgram(this.state.program);
        this.state.active = true;
      } else {
        await this.stopAllPrograms();
        this.state.active = false;
        this.state.speedPct = 0;
      }
    } catch (err) {
      this.platform.log.error(`Pump [${this.deviceId}]: active set failed`, err);
      this.state.active = prevActive;
      this.state.speedPct = prevSpeedPct;
      throw communicationFailure(this.platform.hapApi.hap);
    }
  }

  /** Returns the last-polled rotation speed percentage. */
  private handleSpeedGet(): CharacteristicValue {
    this.assertFresh();
    return this.state.speedPct;
  }

  /**
   * Changes the pump speed by selecting the appropriate program.
   * If the pump is off and a non-zero speed is requested, it is turned on.
   */
  private async handleSpeedSet(value: CharacteristicValue): Promise<void> {
    const speed = value as number;
    if (speed === 0) {
      // Speed set to 0 means stop.
      await this.handleActiveSet(
        this.platform.hapApi.hap.Characteristic.Active.INACTIVE,
      );
      return;
    }

    const program = speedToProgram(speed);
    this.platform.log.info(
      `Pump [${this.deviceId}]: set speed ${speed}% → program ${program}`,
    );

    const prevProgram = this.state.program;
    const prevActive = this.state.active;
    try {
      await this.startProgram(program);
      this.state.program = program;
      this.state.active = true;
    } catch (err) {
      this.platform.log.error(`Pump [${this.deviceId}]: speed set failed`, err);
      this.state.program = prevProgram;
      this.state.active = prevActive;
      throw communicationFailure(this.platform.hapApi.hap);
    }
  }

  private assertFresh(): void {
    if (Date.now() - this.lastPollOk > STALE_AFTER_MS) {
      throw communicationFailure(this.platform.hapApi.hap);
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud API helpers
  // ---------------------------------------------------------------------------

  /** Sends the start command to the cloud API (d25=1 = Enabled). */
  private async startProgram(_program: number): Promise<void> {
    await this.api.sendCommand(this.deviceId, { d25: '1' });
  }

  /** Sends the stop command to the cloud API (d25=0 = OFF). */
  private async stopAllPrograms(): Promise<void> {
    await this.api.sendCommand(this.deviceId, { d25: '0' });
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /** Starts the periodic status polling loop. */
  private startPolling(): void {
    this.pollHandle = setInterval(
      () => this.pollStatus(),
      STATUS_POLL_INTERVAL_MS,
    );
    // Initial fetch immediately.
    this.pollStatus();
  }

  /**
   * Fetches device status from the cloud and updates HomeKit characteristics.
   * Failures are logged but do not throw, keeping the polling loop alive.
   */
  private async pollStatus(): Promise<void> {
    try {
      const status = await this.api.getDeviceStatus(this.deviceId);

      // s14 = active program slot (0-indexed; 0 = off, ≥1 = running).
      // A missing or unparseable s14 is "unknown", not "off".
      const s14 = parseInt(String(status['s14']), 10);
      if (isNaN(s14)) {
        throw new Error(`status has no usable s14 (got ${JSON.stringify(status['s14'])})`);
      }
      const isActive = s14 > 0;

      // s15 = control mode, s16 = current setpoint — use these for display %.
      const mode = parseInt(String(status['s15'] ?? '0'), 10);
      const setpoint = parseInt(String(status['s16'] ?? '0'), 10);
      const speedPct = isActive ? setpointToSpeed(mode, setpoint) : 0;

      this.state.active = isActive;
      this.state.speedPct = speedPct;
      if (isActive) {
        this.state.program = Math.min(Math.max(s14, 1), PROGRAM_COUNT);
      }

      const { Characteristic: Char } = this.platform.hapApi.hap;
      this.service.updateCharacteristic(
        Char.Active,
        isActive ? Char.Active.ACTIVE : Char.Active.INACTIVE,
      );
      this.service.updateCharacteristic(Char.RotationSpeed, speedPct);
      this.lastPollOk = Date.now();
    } catch (err) {
      this.platform.log.warn(`Pump [${this.deviceId}]: status poll failed`, err);
    }
  }
}
