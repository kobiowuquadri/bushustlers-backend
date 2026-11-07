import dotenv from 'dotenv';
import type { SignOptions } from 'jsonwebtoken';

// ENV_FILE lets local development and tests use another file (e.g. a local database) without editing .env.
// Variables already present in the process environment always win over file values.
dotenv.config(process.env.ENV_FILE ? { path: process.env.ENV_FILE } : undefined);

export type AppEnv = 'development' | 'test' | 'sandbox' | 'production';
export type PaymentsProvider = 'demo' | 'busha';
export type BushaEnv = 'sandbox' | 'production';

const problems: string[] = [];
const warnings: string[] = [];

const read = (name: string) => {
    const value = process.env[name];
    return value === undefined ? '' : value.trim();
};

// Fail fast at startup instead of failing on the first request that needs the value
const required = (name: string): string => {
    const value = read(name);
    if (!value) problems.push(`Missing required environment variable: ${name}`);
    return value;
};

const optional = (name: string, fallback = '') => read(name) || fallback;

const bool = (name: string, fallback: boolean) => {
    const value = read(name).toLowerCase();
    if (!value) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    problems.push(`${name} must be true or false`);
    return fallback;
};

const int = (name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const value = read(name);
    if (!value) return fallback;
    if (!/^-?\d+$/.test(value)) {
        problems.push(`${name} must be a whole number`);
        return fallback;
    }
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
        problems.push(`${name} must be between ${min} and ${max}`);
        return fallback;
    }
    return parsed;
};

const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T | ''): T => {
    const value = read(name) as T;
    if (!value) {
        if (!fallback) problems.push(`Missing required environment variable: ${name} (one of ${allowed.join(', ')})`);
        return fallback as T;
    }
    if (!allowed.includes(value)) {
        problems.push(`${name} must be one of: ${allowed.join(', ')}`);
        return (fallback || allowed[0]) as T;
    }
    return value;
};

const url = (name: string, fallback = '') => {
    const value = optional(name, fallback).replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch {
        problems.push(`${name} must be an absolute http(s) URL`);
    }
    return value;
};

const nodeEnv = read('NODE_ENV') || 'development';
const appEnv = oneOf<AppEnv>('APP_ENV', ['development', 'test', 'sandbox', 'production'], nodeEnv === 'production' ? 'production' : nodeEnv === 'test' ? 'test' : 'development');
const isDeployed = appEnv === 'sandbox' || appEnv === 'production';
const isLocal = appEnv === 'development' || appEnv === 'test';

const secretKey = required('SECRET_KEY');
if (secretKey && secretKey.length < 32) {
    if (isDeployed) problems.push('SECRET_KEY must be at least 32 characters outside local development');
    else warnings.push('SECRET_KEY is shorter than 32 characters; use a long random value before deploying');
}

const frontendUrl = isDeployed ? url('FRONTEND_URL') : url('FRONTEND_URL', 'http://localhost:3000');
if (isDeployed && !frontendUrl) problems.push('Missing required environment variable: FRONTEND_URL');
if (appEnv === 'production' && frontendUrl && !frontendUrl.startsWith('https://')) problems.push('FRONTEND_URL must use https in production');

const corsOrigins = (read('CORS_ORIGIN') || frontendUrl).split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);

// ---- Payments -------------------------------------------------------------------------------
const paymentsProvider = oneOf<PaymentsProvider>('PAYMENTS_PROVIDER', ['demo', 'busha'], isLocal ? 'demo' : '');
const bushaEnv = oneOf<BushaEnv>('BUSHA_ENV', ['sandbox', 'production'], 'sandbox');
const BUSHA_SANDBOX_URL = 'https://api.sandbox.busha.so';

const busha = {
    env: bushaEnv,
    // Production must be explicit: the guides and the OpenAPI file list different production hosts.
    baseUrl: url('BUSHA_BASE_URL', bushaEnv === 'sandbox' ? BUSHA_SANDBOX_URL : ''),
    secretKey: read('BUSHA_SECRET_KEY'),
    publicKey: read('BUSHA_PUBLIC_KEY'),
    webhookSecret: read('BUSHA_WEBHOOK_SECRET'),
    timeoutMs: int('BUSHA_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000 }),
    // Asset:network pairs offered at checkout. Validated against Busha's documented list in constants/payments.ts.
    stablecoinOptions: optional('BUSHA_STABLECOIN_OPTIONS', 'USDT:TRX,USDT:BSC,USDC:BASE'),
};

if (paymentsProvider === 'busha') {
    if (!busha.secretKey) problems.push('BUSHA_SECRET_KEY is required when PAYMENTS_PROVIDER=busha');
    if (!busha.publicKey) problems.push('BUSHA_PUBLIC_KEY is required when PAYMENTS_PROVIDER=busha');
    if (!busha.webhookSecret) problems.push('BUSHA_WEBHOOK_SECRET is required when PAYMENTS_PROVIDER=busha');
    if (bushaEnv === 'production') {
        if (!read('BUSHA_BASE_URL')) problems.push('BUSHA_BASE_URL must be set explicitly for BUSHA_ENV=production');
        if (appEnv !== 'production') problems.push('BUSHA_ENV=production is only allowed with APP_ENV=production');
        if (!bool('ALLOW_LIVE_PAYMENTS', false)) problems.push('Set ALLOW_LIVE_PAYMENTS=true to confirm that live Busha payments are authorised');
    }
}
if (appEnv === 'production') {
    if (paymentsProvider !== 'busha') problems.push('APP_ENV=production requires PAYMENTS_PROVIDER=busha (demo mode is not allowed in production)');
    if (bushaEnv !== 'production') problems.push('APP_ENV=production requires BUSHA_ENV=production; use APP_ENV=sandbox for sandbox deployments');
}

const paymentsMode: 'demo' | 'sandbox' | 'production' = paymentsProvider === 'demo' ? 'demo' : bushaEnv;

// ---- Database --------------------------------------------------------------------------------
const database = {
    name: required('DB_NAME'),
    user: required('DB_USER'),
    password: read('DB_PASSWORD'),
    host: optional('DB_HOST', 'localhost'),
    port: int('DB_PORT', 3306, { min: 1, max: 65535 }),
    ssl: bool('DB_SSL', false),
    sslRejectUnauthorized: bool('DB_SSL_REJECT_UNAUTHORIZED', true),
    migrateOnStart: bool('DB_MIGRATE_ON_START', false),
    poolMax: int('DB_POOL_MAX', 5, { min: 1, max: 50 }),
};
if (isDeployed && !database.ssl) warnings.push('DB_SSL is off; enable it if your database host supports TLS');

export const config = {
    app: {
        name: optional('APP_NAME', 'Bushustlers'),
        env: appEnv,
        isLocal,
        isDeployed,
        isProduction: appEnv === 'production',
        frontendUrl,
        supportEmail: read('SUPPORT_EMAIL'),
    },
    server: {
        env: nodeEnv,
        isProduction: nodeEnv === 'production',
        port: int('PORT', 5000, { min: 1, max: 65535 }),
        corsOrigins,
        // Number of reverse proxies in front of the app (e.g. 1 on Render, 2 when calls also pass through the Next.js rewrite proxy)
        trustProxy: int('TRUST_PROXY', 0, { min: 0, max: 5 }),
    },
    database,
    jwt: {
        secret: secretKey,
        accessTokenExpiresIn: (optional('ACCESS_TOKEN_EXPIRES_IN', '15m')) as SignOptions['expiresIn'],
    },
    session: {
        ttlDays: int('SESSION_TTL_DAYS', 7, { min: 1, max: 90 }),
        cookieSecure: bool('COOKIE_SECURE', isDeployed),
    },
    email: {
        user: read('EMAIL_USER'),
        password: read('EMAIL_PASSWORD'),
        // Captures emails in the database instead of sending them. Only ever enabled for local development.
        devMailbox: isLocal && bool('DEV_MAILBOX', true),
    },
    brevo: {
        apiKey: read('BREVO_API_KEY'),
        apiUrl: optional('BREVO_API_URL', 'https://api.brevo.com/v3/smtp/email'),
        senderEmail: read('BREVO_SENDER_EMAIL'),
        senderName: optional('BREVO_SENDER_NAME', optional('APP_NAME', 'Bushustlers')),
    },
    cloudinary: {
        cloudName: read('CLOUDINARY_CLOUD_NAME') || read('CLOUDINARY_NAME'),
        apiKey: read('CLOUDINARY_API_KEY'),
        apiSecret: read('CLOUDINARY_API_SECRET'),
    },
    payments: {
        provider: paymentsProvider,
        mode: paymentsMode,
        // Simulation controls are merchant-side only and never available in production.
        demoToolsEnabled: appEnv !== 'production' && bool('DEMO_TOOLS', true),
        // Demo-only display rate for stablecoin quotes. Never used for a real provider.
        demoNgnPerUsd: optional('DEMO_NGN_PER_USD', '1500.00'),
        linkTtlHoursDefault: int('PAYMENT_LINK_TTL_HOURS', 72, { min: 1, max: 24 * 30 }),
        reconcileIntervalSeconds: int('RECONCILE_INTERVAL_SECONDS', appEnv === 'test' ? 0 : 60, { min: 0, max: 3600 }),
        busha,
    },
    // Proposed pricing from the latest pitch deck. Fees are paid by the business, never added to the buyer's total.
    fees: {
        ngnBps: int('PLATFORM_FEE_NGN_BPS', 100, { min: 0, max: 10_000 }),
        ngnCapMinor: int('PLATFORM_FEE_NGN_CAP_MINOR', 100_000, { min: 0 }),
        stablecoinBps: int('PLATFORM_FEE_STABLECOIN_BPS', 150, { min: 0, max: 10_000 }),
        status: 'proposed' as const,
    },
};

export const configWarnings = warnings;

if (problems.length) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
}
