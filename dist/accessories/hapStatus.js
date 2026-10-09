"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STALE_AFTER_MS = void 0;
exports.communicationFailure = communicationFailure;
const settings_1 = require("../settings");
/** Cached state older than this (three missed polls) is reported to HomeKit as "No Response". */
exports.STALE_AFTER_MS = 3 * settings_1.STATUS_POLL_INTERVAL_MS;
/** The error HomeKit shows as "No Response" / "Not Responding". */
function communicationFailure(hap) {
    return new hap.HapStatusError(-70402 /* hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
}
