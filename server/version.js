import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageInfo = require('../package.json');

export const SERVICE_VERSION = packageInfo.version;
export const LIVE_ACTIVITY_CONTRACT_VERSION = 1;
export const SOURCE_REVISION = process.env.TUBEBOARD_GIT_SHA || 'unknown';
