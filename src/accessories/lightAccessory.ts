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

import type {
  PlatformAccessory,
  CharacteristicValue,
  Service,
} from 'homebridge';
import type { PentairHomebridgePlatform } from '../platform';
import type { PentairApi } from '../pentairApi';
import { STATUS_POLL_INTERVAL_MS } from '../settings';
import { STALE_AFTER_MS, communicationFailure } from './hapStatus';

/** Configuration block expected under `config.light`. */
export interface LightConfig {
  deviceId: string;
  name: string;
}

/**
 * Pentair PLC1 v2 API color indices (field d1).
 * Values match what the device reports and what sendCommand should send.
 */
export const enum PentairColor {
  SAM       = 1,
  Party     = 2,
  Romance   = 3,
  Caribbean = 4,
  American  = 5,
  Sunset    = 6,
  Royal     = 7,
  Blue      = 8,
  Green     = 9,
  Red       = 10,
  White     = 11,
  Magenta   = 12,
}

/** Representative HomeKit hue for each Pentair color index. */
const COLOR_TO_HUE: Record<number, number> = {
  [PentairColor.SAM]:       0,    // show mode — map to red as placeholder
  [PentairColor.Party]:    40,
  [PentairColor.Romance]: 275,
  [PentairColor.Caribbean]: 175,
  [PentairColor.American]: 210,
  [PentairColor.Sunset]:   25,
  [PentairColor.Royal]:   255,
  [PentairColor.Blue]:    230,
  [PentairColor.Green]:   100,
  [PentairColor.Red]:      10,
  [PentairColor.White]:     0,   // saturation 0
  [PentairColor.Magenta]: 315,
};

function hueToColorIndex(hue: number, saturation: number): PentairColor {
  if (saturation < 20) return PentairColor.White;

  const h = ((hue % 360) + 360) % 360;

  if (h <= 20 || h >= 340)   return PentairColor.Red;
  if (h <= 60)                return PentairColor.Party;
  if (h <= 150)               return PentairColor.Green;
  if (h <= 200)               return PentairColor.Caribbean;
  if (h <= 260)               return PentairColor.Blue;
  if (h <= 290)               return PentairColor.Romance;
  /* 291–339 */               return PentairColor.Magenta;
}

/**
 * Homebridge accessory that bridges a Pentair IntelliBrite light to HomeKit.
 *
 * Registered and restored by `PentairHomebridgePlatform.discoverDevices()`.
 */
export class PentairLightAccessory {
  private readonly service: Service;
  private readonly api: PentairApi;
  private readonly deviceId: string;
  private readonly platform: PentairHomebridgePlatform;
  private readonly accessory: PlatformAccessory;

  /** Locally cached state to avoid redundant cloud round-trips. */
  private state = {
    on: false,
    colorIndex: PentairColor.White as PentairColor,
  };

  /** Derived hue/saturation so HomeKit reads are consistent with color index. */
  private hue = 0;
  private saturation = 0;

  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /** When the cached state was last confirmed by the cloud (starts as a grace period). */
  private lastPollOk = Date.now();

  constructor(
    platform: PentairHomebridgePlatform,
    accessory: PlatformAccessory,
    api: PentairApi,
    config: LightConfig,
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
      .setCharacteristic(Char.Model, 'IntelliBrite Color Light')
      .setCharacteristic(Char.SerialNumber, config.deviceId);

    // ---------------------------------------------------------------------------
    // Lightbulb service
    // ---------------------------------------------------------------------------
    this.service =
      this.accessory.getService(Svc.Lightbulb) ??
      this.accessory.addService(Svc.Lightbulb, config.name);

    // On / Off
    this.service
      .getCharacteristic(Char.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));

    // Hue
    this.service
      .getCharacteristic(Char.Hue)
      .onGet(this.handleHueGet.bind(this))
      .onSet(this.handleHueSet.bind(this));

    // Saturation
    this.service
      .getCharacteristic(Char.Saturation)
      .onGet(this.handleSaturationGet.bind(this))
      .onSet(this.handleSaturationSet.bind(this));

    this.startPolling();
  }

  // ---------------------------------------------------------------------------
  // HomeKit characteristic handlers
  // ---------------------------------------------------------------------------

  private handleOnGet(): CharacteristicValue {
    this.assertFresh();
    return this.state.on;
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.platform.log.info(`Light [${this.deviceId}]: set on → ${on}`);
    try {
      await this.api.sendCommand(this.deviceId, { d13: on ? '1' : '0' });
      this.state.on = on;
    } catch (err) {
      this.platform.log.error(`Light [${this.deviceId}]: on/off set failed`, err);
      throw communicationFailure(this.platform.hapApi.hap);
    }
  }

  private handleHueGet(): CharacteristicValue {
    this.assertFresh();
    return this.hue;
  }

  private async handleHueSet(value: CharacteristicValue): Promise<void> {
    this.hue = value as number;
    await this.scheduleColorChange();
  }

  private handleSaturationGet(): CharacteristicValue {
    this.assertFresh();
    return this.saturation;
  }

  private async handleSaturationSet(value: CharacteristicValue): Promise<void> {
    this.saturation = value as number;
    await this.scheduleColorChange();
  }

  /**
   * Hue and saturation arrive as separate writes, often together, so they are
   * debounced into one command. Every caller in the window waits on that one
   * command, so a failure is reported back to HomeKit instead of only logged.
   */
  private colorDebounce: ReturnType<typeof setTimeout> | null = null;
  private colorWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

  private scheduleColorChange(): Promise<void> {
    if (this.colorDebounce) clearTimeout(this.colorDebounce);
    const done = new Promise<void>((resolve, reject) => this.colorWaiters.push({ resolve, reject }));
    this.colorDebounce = setTimeout(() => {
      this.colorDebounce = null;
      const waiters = this.colorWaiters;
      this.colorWaiters = [];
      this.applyColorChange().then(
        () => waiters.forEach((w) => w.resolve()),
        (err) => {
          this.platform.log.error(`Light [${this.deviceId}]: color set failed`, err);
          const hapErr = communicationFailure(this.platform.hapApi.hap);
          waiters.forEach((w) => w.reject(hapErr));
        },
      );
    }, 300);
    return done;
  }

  private assertFresh(): void {
    if (Date.now() - this.lastPollOk > STALE_AFTER_MS) {
      throw communicationFailure(this.platform.hapApi.hap);
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud API helpers
  // ---------------------------------------------------------------------------

  /**
   * Derives the Pentair color index from the current hue/saturation and sends
   * the `lco` command to the cloud API.
   */
  private async applyColorChange(): Promise<void> {
    const colorIndex = hueToColorIndex(this.hue, this.saturation);
    this.platform.log.info(
      `Light [${this.deviceId}]: set color → ${colorIndex} ` +
      `(hue=${this.hue}, sat=${this.saturation})`,
    );

    await this.api.sendCommand(this.deviceId, {
      d1: String(colorIndex),
    });

    this.state.colorIndex = colorIndex;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.pollHandle = setInterval(
      () => this.pollStatus(),
      STATUS_POLL_INTERVAL_MS,
    );
    this.pollStatus();
  }

  /**
   * Fetches device status and propagates changes to HomeKit characteristics.
   */
  private async pollStatus(): Promise<void> {
    try {
      const status = await this.api.getDeviceStatus(this.deviceId);

      // d13: On/Off (0=OFF, 1=ON). A missing d13 is "unknown", not "off".
      const d13Raw = status['d13'];
      if (d13Raw === undefined || d13Raw === null) {
        throw new Error('status has no d13');
      }
      const isOn = d13Raw === '1' || d13Raw === 1 || d13Raw === true;

      // d1: Light Mode/Color (1=SAM, 2=Party, ... 11=White, 12=Magenta)
      const d1Raw = status['d1'];
      let colorIndex: PentairColor = this.state.colorIndex;
      if (d1Raw !== undefined && d1Raw !== null) {
        const parsed = parseInt(String(d1Raw), 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 12) {
          colorIndex = parsed as PentairColor;
        }
      }

      this.state.on = isOn;
      this.state.colorIndex = colorIndex;

      // Derive hue/saturation from color index for HomeKit.
      const newHue = COLOR_TO_HUE[colorIndex] ?? 0;
      const newSat = (colorIndex === PentairColor.White || colorIndex === PentairColor.SAM) ? 0 : 100;
      this.hue = newHue;
      this.saturation = newSat;

      const { Characteristic: Char } = this.platform.hapApi.hap;
      this.service.updateCharacteristic(Char.On, isOn);
      this.service.updateCharacteristic(Char.Hue, newHue);
      this.service.updateCharacteristic(Char.Saturation, newSat);
      this.lastPollOk = Date.now();
    } catch (err) {
      this.platform.log.warn(`Light [${this.deviceId}]: status poll failed`, err);
    }
  }
}
