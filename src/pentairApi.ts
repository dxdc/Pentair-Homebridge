/**
 * PentairApi – thin HTTP client for the Pentair Home cloud API.
 *
 * Every request is signed with AWS Signature Version 4 using the temporary
 * credentials obtained by PentairAuth.  The underlying transport is the
 * global `fetch` API available in Node >=18.
 */

import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import type { Logger } from 'homebridge';
import type { PentairAuth } from './auth';
import {
  API_BASE_HOST,
  API_SERVICE_NAME,
  AWS_REGION,
  ENDPOINT_DEVICE_STATUS,
  ENDPOINT_LIST_DEVICES,
  ENDPOINT_SEND_COMMAND,
} from './settings';

/** Shape of a device returned by the list-devices endpoint. */
export interface PentairDevice {
  deviceId: string;
  deviceType?: string;
  name?: string;
  [key: string]: unknown;
}

/** Generic map of status fields returned by the device-status endpoint. */
export type DeviceStatus = Record<string, string | number | boolean | null>;

/** Payload sent to the send-command endpoint. */
export type CommandPayload = Record<string, string>;

/**
 * Low-level client for the Pentair Cloud REST API.
 *
 * Responsibilities:
 *  - SigV4-sign every outgoing request
 *  - Refresh credentials via `PentairAuth` before each call
 *  - Expose typed methods for each API operation
 */
export class PentairApi {
  private readonly auth: PentairAuth;
  private readonly log: Logger;
  private readonly debugLogging: boolean;

  constructor(auth: PentairAuth, log: Logger, debugLogging = false) {
    this.auth = auth;
    this.log = log;
    this.debugLogging = debugLogging;
  }

  // ---------------------------------------------------------------------------
  // Public API methods
  // ---------------------------------------------------------------------------

  /**
   * Retrieves all devices associated with the authenticated user account.
   *
   * @returns Array of device descriptors.
   */
  async getDevices(): Promise<PentairDevice[]> {
    const response = await this.signedRequest('GET', ENDPOINT_LIST_DEVICES);
    // The API may return either an array directly or wrap it in a property.
    if (Array.isArray(response)) {
      return response as PentairDevice[];
    }
    if (response && typeof response === 'object') {
      const obj = response as Record<string, unknown>;
      // Common wrappers: { devices: [...] } or { data: [...] }
      for (const key of ['devices', 'data', 'items', 'results']) {
        if (Array.isArray(obj[key])) {
          return obj[key] as PentairDevice[];
        }
      }
    }
    this.log.warn('PentairApi: unexpected shape from getDevices, returning []');
    return [];
  }

  /**
   * Fetches the current status of a single device.
   *
   * @param deviceId - The Pentair device identifier.
   * @returns A flat key/value map of status fields.
   */
  async getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
    const raw = await this.signedRequest('POST', ENDPOINT_DEVICE_STATUS, { deviceIds: [deviceId] });

    // Response: { response: { data: [{ fields: { key: { value } } }] } }
    type FieldEntry = { value: string | number | boolean | null };
    type Envelope = { data?: Array<{ fields?: Record<string, FieldEntry> }> };
    const envelope = (raw as { response?: Envelope })?.response;
    const data = envelope?.data ?? [];

    if (this.debugLogging) {
      this.log.info(`PentairApi: getDeviceStatus(${deviceId}) raw → ${JSON.stringify(raw)}`);
    }

    // An empty payload means "no information", not "everything is off" - treat it as a failed poll.
    if (data.length === 0 || !data[0].fields) {
      throw new Error(`PentairApi: getDeviceStatus(${deviceId}) returned no data`);
    }

    const status: DeviceStatus = {};
    for (const [key, field] of Object.entries(data[0].fields!)) {
      status[key] = field.value;
    }

    if (this.debugLogging) {
      this.log.info(`PentairApi: getDeviceStatus(${deviceId}) parsed → ${JSON.stringify(status)}`);
    }

    return status;
  }

  /**
   * Sends a command payload to a device.
   *
   * @param deviceId - The target device identifier.
   * @param payload  - Key/value command fields (e.g. `{ lse: '1' }`).
   */
  async sendCommand(deviceId: string, payload: CommandPayload): Promise<void> {
    const path = ENDPOINT_SEND_COMMAND.replace('{deviceId}', deviceId);
    await this.signedRequest('PUT', path, { payload });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Creates, signs, and sends an HTTP request to the Pentair API.
   *
   * @param method - HTTP method (GET | POST | PUT).
   * @param path   - API path, starting with '/'.
   * @param body   - Optional request body (will be JSON-serialised).
   * @returns Parsed JSON response body.
   */
  private async signedRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    // Ensure credentials are fresh before signing.
    const [credentials, idToken] = await Promise.all([
      this.auth.getCredentials(),
      this.auth.getIdToken(),
    ]);

    const bodyString = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      host: API_BASE_HOST,
      'x-amz-id-token': idToken,
      'user-agent': 'aws-amplify/4.3.10 react-native',
    };
    if (bodyString) {
      headers['content-type'] = 'application/json; charset=UTF-8';
      headers['content-length'] = String(Buffer.byteLength(bodyString, 'utf-8'));
    }

    // Build the request object that SignatureV4 will sign.
    const request = new HttpRequest({
      method,
      protocol: 'https:',
      hostname: API_BASE_HOST,
      path,
      headers,
      body: bodyString,
    });

    // Sign with SigV4.
    const signer = new SignatureV4({
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      region: AWS_REGION,
      service: API_SERVICE_NAME,
      sha256: Sha256,
    });

    const signed = await signer.sign(request);

    // Convert signed headers to a plain object understood by fetch.
    const fetchHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(signed.headers)) {
      fetchHeaders[key] = value;
    }

    const url = `https://${API_BASE_HOST}${path}`;
    this.log.debug(`PentairApi: ${method} ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const fetchOptions: RequestInit = {
      method,
      headers: fetchHeaders,
      signal: controller.signal,
    };
    if (bodyString) {
      fetchOptions.body = bodyString;
    }

    let response: Response;
    let text = '';
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      throw new Error(`PentairApi: ${method} ${path} → network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      try {
        text = await response.text();
      } catch {
        text = '<could not read body>';
      }
      // Truncate error body to 200 chars to avoid leaking internal API details in logs
      const safeText = text.length > 200 ? text.slice(0, 200) + '…(truncated)' : text;
      throw new Error(
        `PentairApi: ${method} ${path} → HTTP ${response.status}: ${safeText}`,
      );
    }

    // 204 No Content or similar – nothing to parse.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return null;
    }

    // Read with a 1 MB cap to prevent memory exhaustion from malicious responses.
    text = await response.text();
    if (text.length > 1_048_576) {
      throw new Error(`PentairApi: response body too large (${text.length} bytes, max 1 MB)`);
    }

    const json: unknown = JSON.parse(text);
    return json;
  }
}
