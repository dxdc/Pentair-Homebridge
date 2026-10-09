"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PentairAuth = void 0;
const node_crypto_1 = require("node:crypto");
const client_cognito_identity_provider_1 = require("@aws-sdk/client-cognito-identity-provider");
const client_cognito_identity_1 = require("@aws-sdk/client-cognito-identity");
const settings_1 = require("./settings");
// ---------------------------------------------------------------------------
// SRP constants (RFC 5054 2048-bit group)
// ---------------------------------------------------------------------------
const N_HEX = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
    '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
    'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
    'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
    '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
    'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
    '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
    'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
    'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
    'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
    'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
    '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
const N = BigInt('0x' + N_HEX);
const g = BigInt(2);
// ---------------------------------------------------------------------------
// SRP helpers
// ---------------------------------------------------------------------------
function sha256hex(input) {
    return (0, node_crypto_1.createHash)('sha256').update(input).digest('hex').padStart(64, '0');
}
function hexHash(hexStr) {
    return sha256hex(Buffer.from(hexStr, 'hex'));
}
/** Encodes a BigInt as a hex string with two's-complement padding (MSB-safe). */
function padHex(value) {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0)
        hex = '0' + hex;
    if (/^[89a-fA-F]/.test(hex))
        hex = '00' + hex;
    return hex;
}
function modPow(base, exp, mod) {
    let result = BigInt(1);
    base = ((base % mod) + mod) % mod;
    while (exp > BigInt(0)) {
        if (exp % BigInt(2) === BigInt(1))
            result = (result * base) % mod;
        exp = exp / BigInt(2);
        base = (base * base) % mod;
    }
    return result;
}
function hkdf(ikm, salt) {
    const prk = (0, node_crypto_1.createHmac)('sha256', salt).update(ikm).digest();
    const info = Buffer.from('Caldera Derived Key\x01', 'utf8');
    return (0, node_crypto_1.createHmac)('sha256', prk).update(info).digest().subarray(0, 16);
}
/** Formats a Date as "EEE MMM D HH:mm:ss UTC YYYY" per Cognito spec. */
function cognitoTimestamp(d) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm}:${ss} UTC ${d.getUTCFullYear()}`;
}
// Pre-compute k (constant for this group)
const k = BigInt('0x' + hexHash(padHex(N) + padHex(g)));
// Pool name suffix (part after '_'), used inside SRP signature
const POOL_NAME = settings_1.COGNITO_USER_POOL_ID.split('_')[1];
// ---------------------------------------------------------------------------
// Auth class
// ---------------------------------------------------------------------------
function jwtExpiry(token) {
    try {
        const payload = token.split('.')[1];
        const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
        return JSON.parse(decoded).exp ?? 0;
    }
    catch {
        return 0;
    }
}
class PentairAuth {
    constructor(username, password) {
        this.session = null;
        this.username = username;
        this.password = password;
        this.srpClient = new client_cognito_identity_provider_1.CognitoIdentityProviderClient({ region: settings_1.AWS_REGION });
        this.identityClient = new client_cognito_identity_1.CognitoIdentityClient({ region: settings_1.AWS_REGION });
    }
    async authenticate() {
        const { idToken, refreshToken } = await this.fetchTokens();
        const { credentials, expiry: credentialsExpiry } = await this.fetchCredentials(idToken);
        this.session = {
            idToken,
            refreshToken,
            idTokenExpiry: jwtExpiry(idToken),
            credentials,
            credentialsExpiry,
        };
    }
    async refreshIfNeeded() {
        const BUFFER_SECONDS = 300;
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!this.session) {
            await this.authenticate();
            return;
        }
        if (this.session.idTokenExpiry - nowSeconds > BUFFER_SECONDS) {
            return;
        }
        try {
            const refreshed = await this.refreshTokens(this.session.refreshToken);
            const { credentials, expiry: credentialsExpiry } = await this.fetchCredentials(refreshed.idToken);
            this.session = {
                idToken: refreshed.idToken,
                refreshToken: this.session.refreshToken,
                idTokenExpiry: jwtExpiry(refreshed.idToken),
                credentials,
                credentialsExpiry,
            };
        }
        catch {
            await this.authenticate();
        }
    }
    async getCredentials() {
        await this.refreshIfNeeded();
        if (!this.session)
            throw new Error('PentairAuth: no session after refresh');
        return this.session.credentials;
    }
    async getIdToken() {
        await this.refreshIfNeeded();
        if (!this.session)
            throw new Error('PentairAuth: no session after refresh');
        return this.session.idToken;
    }
    // ---------------------------------------------------------------------------
    // Private: full SRP auth flow
    // ---------------------------------------------------------------------------
    async fetchTokens() {
        // Step 1: generate ephemeral key pair (secret exponent must come from a CSPRNG)
        const a = BigInt('0x' + (0, node_crypto_1.randomBytes)(32).toString('hex'));
        const A = modPow(g, a, N);
        const srpA = padHex(A);
        // Step 2: InitiateAuth → PASSWORD_VERIFIER challenge
        const initResp = await this.srpClient.send(new client_cognito_identity_provider_1.InitiateAuthCommand({
            AuthFlow: 'USER_SRP_AUTH',
            ClientId: settings_1.COGNITO_CLIENT_ID,
            AuthParameters: {
                USERNAME: this.username,
                SRP_A: srpA,
            },
        }));
        if (initResp.ChallengeName !== 'PASSWORD_VERIFIER') {
            throw new Error(`PentairAuth: unexpected challenge: ${initResp.ChallengeName}`);
        }
        const params = initResp.ChallengeParameters;
        const saltHex = params['SALT'];
        const srpB = params['SRP_B'];
        const secretBlock = params['SECRET_BLOCK'];
        const userIdForSrp = params['USER_ID_FOR_SRP'] ?? this.username;
        // Step 3: compute SRP proof
        // SRP-6a safety checks (RFC 5054 §2.6): abort if B % N == 0 or u == 0.
        const B = BigInt('0x' + srpB);
        if (B % N === BigInt(0)) {
            throw new Error('PentairAuth: invalid SRP_B from server');
        }
        const u = BigInt('0x' + hexHash(padHex(A) + padHex(B)));
        if (u === BigInt(0)) {
            throw new Error('PentairAuth: invalid SRP scrambling parameter');
        }
        const x = BigInt('0x' + hexHash(padHex(BigInt('0x' + saltHex)) + sha256hex(POOL_NAME + userIdForSrp + ':' + this.password)));
        const kGPowX = (k * modPow(g, x, N)) % N;
        const S = modPow(((B - kGPowX) % N + N) % N, a + u * x, N);
        const hkdfKey = hkdf(Buffer.from(padHex(S), 'hex'), Buffer.from(padHex(u), 'hex'));
        const now = new Date();
        const timestamp = cognitoTimestamp(now);
        const signature = (0, node_crypto_1.createHmac)('sha256', hkdfKey)
            .update(Buffer.from(POOL_NAME, 'utf8'))
            .update(Buffer.from(userIdForSrp, 'utf8'))
            .update(Buffer.from(secretBlock, 'base64'))
            .update(Buffer.from(timestamp, 'utf8'))
            .digest('base64');
        // Step 4: respond to challenge
        const authResp = await this.srpClient.send(new client_cognito_identity_provider_1.RespondToAuthChallengeCommand({
            ChallengeName: 'PASSWORD_VERIFIER',
            ClientId: settings_1.COGNITO_CLIENT_ID,
            ChallengeResponses: {
                USERNAME: userIdForSrp,
                PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
                PASSWORD_CLAIM_SIGNATURE: signature,
                TIMESTAMP: timestamp,
            },
        }));
        const result = authResp.AuthenticationResult;
        if (!result?.IdToken || !result.RefreshToken) {
            throw new Error('PentairAuth: authentication did not return tokens');
        }
        return { idToken: result.IdToken, refreshToken: result.RefreshToken };
    }
    async refreshTokens(refreshToken) {
        const resp = await this.srpClient.send(new client_cognito_identity_provider_1.InitiateAuthCommand({
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            ClientId: settings_1.COGNITO_CLIENT_ID,
            AuthParameters: { REFRESH_TOKEN: refreshToken },
        }));
        const idToken = resp.AuthenticationResult?.IdToken;
        if (!idToken)
            throw new Error('PentairAuth: refresh did not return IdToken');
        return { idToken };
    }
    async fetchCredentials(idToken) {
        const getIdResp = await this.identityClient.send(new client_cognito_identity_1.GetIdCommand({
            IdentityPoolId: settings_1.COGNITO_IDENTITY_POOL_ID,
            Logins: { [settings_1.COGNITO_LOGIN_KEY]: idToken },
        }));
        const identityId = getIdResp.IdentityId;
        if (!identityId)
            throw new Error('PentairAuth: GetId returned no IdentityId');
        const credsResp = await this.identityClient.send(new client_cognito_identity_1.GetCredentialsForIdentityCommand({
            IdentityId: identityId,
            Logins: { [settings_1.COGNITO_LOGIN_KEY]: idToken },
        }));
        const raw = credsResp.Credentials;
        if (!raw?.AccessKeyId || !raw.SecretKey || !raw.SessionToken) {
            throw new Error('PentairAuth: GetCredentialsForIdentity returned incomplete credentials');
        }
        return {
            credentials: {
                accessKeyId: raw.AccessKeyId,
                secretAccessKey: raw.SecretKey,
                sessionToken: raw.SessionToken,
            },
            expiry: raw.Expiration
                ? Math.floor(raw.Expiration.getTime() / 1000)
                : jwtExpiry(idToken),
        };
    }
}
exports.PentairAuth = PentairAuth;
