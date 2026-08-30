const readableSchemaVersions = new Set([1, 2]);
const maximumFragmentLength = 2048;
const maximumDecodedBytes = 1024;
const maximumLifetimeSeconds = 45 * 60;
const allowedPayloadKeys = new Set([
  'version',
  'lineID',
  'vehicleID',
  'sourceStationID',
  'sourcePredictionID',
  'expectedArrival',
  'destinationStationID',
  'direction',
  'journeyAnchorStationID',
  'issuedAtSeconds',
  'expiresAtSeconds'
]);
const lineNames = new Map([
  ['bakerloo', 'Bakerloo'],
  ['central', 'Central'],
  ['circle', 'Circle'],
  ['district', 'District'],
  ['elizabeth', 'Elizabeth'],
  ['hammersmith-city', 'Hammersmith & City'],
  ['jubilee', 'Jubilee'],
  ['liberty', 'Liberty'],
  ['lioness', 'Lioness'],
  ['metropolitan', 'Metropolitan'],
  ['mildmay', 'Mildmay'],
  ['northern', 'Northern'],
  ['piccadilly', 'Piccadilly'],
  ['suffragette', 'Suffragette'],
  ['victoria', 'Victoria'],
  ['waterloo-city', 'Waterloo & City'],
  ['weaver', 'Weaver'],
  ['windrush', 'Windrush']
]);

export function decodeTrainSelection(fragment, nowSeconds = Date.now() / 1000) {
  if (typeof fragment !== 'string'
      || fragment.length === 0
      || fragment.length > maximumFragmentLength
      || !/^[A-Za-z0-9_-]+$/.test(fragment)) {
    return { state: 'invalid' };
  }

  let bytes;
  try {
    const padding = '='.repeat((4 - fragment.length % 4) % 4);
    const binary = atob(fragment.replaceAll('-', '+').replaceAll('_', '/') + padding);
    if (binary.length > maximumDecodedBytes) return { state: 'invalid' };
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return { state: 'invalid' };
  }

  let selection;
  try {
    selection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { state: 'invalid' };
  }

  if (!isValidSelection(selection)) return { state: 'invalid' };
  if (nowSeconds >= selection.expiresAtSeconds) {
    return { state: 'expired', expiresAtSeconds: selection.expiresAtSeconds };
  }

  return {
    state: 'valid',
    lineID: selection.lineID,
    lineName: lineNames.get(selection.lineID),
    expiresAtSeconds: selection.expiresAtSeconds
  };
}

function isValidSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
  if (!Object.keys(selection).every((key) => allowedPayloadKeys.has(key))) return false;
  if (!Number.isSafeInteger(selection.version)
      || !readableSchemaVersions.has(selection.version)
      || !lineNames.has(selection.lineID)) return false;
  if (!validIdentifier(selection.lineID, 64)
      || !validIdentifier(selection.vehicleID, 96)
      || !usableTrainIdentifier(selection.vehicleID)
      || !validIdentifier(selection.sourceStationID, 96)
      || !validIdentifier(selection.sourcePredictionID, 128)
      || !validTimestamp(selection.expectedArrival)) return false;
  if (selection.destinationStationID != null
      && !validIdentifier(selection.destinationStationID, 96)) return false;
  if (selection.direction != null && !validText(selection.direction, 32)) return false;
  const hasJourneyAnchor = Object.hasOwn(selection, 'journeyAnchorStationID');
  if (selection.version === 1 && hasJourneyAnchor) return false;
  if (selection.version === 2
      && (!hasJourneyAnchor || !validIdentifier(selection.journeyAnchorStationID, 96))) return false;
  if (!Number.isSafeInteger(selection.issuedAtSeconds)
      || !Number.isSafeInteger(selection.expiresAtSeconds)
      || selection.expiresAtSeconds <= selection.issuedAtSeconds
      || selection.expiresAtSeconds - selection.issuedAtSeconds > maximumLifetimeSeconds) return false;
  return true;
}

function usableTrainIdentifier(value) {
  const normalized = value.trim().toLowerCase();
  const placeholders = new Set([
    '-',
    '--',
    'changed',
    'n/a',
    'na',
    'not available',
    'null',
    'train changed',
    'unknown'
  ]);
  return !placeholders.has(normalized) && !/^0+$/.test(normalized);
}

function validIdentifier(value, maximumLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && /^[A-Za-z0-9._-]+$/.test(value);
}

function validText(value, maximumLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && !/[\r\n]/.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string'
    && value.length <= 40
    && !Number.isNaN(Date.parse(value));
}

if (typeof document !== 'undefined') {
  const status = document.getElementById('train-status');
  const detail = document.getElementById('train-detail');
  const deviceDetail = document.getElementById('train-device-detail');
  const appStoreLink = document.getElementById('train-app-store-link');
  const result = decodeTrainSelection(window.location.hash.slice(1));
  const isIPhone = /iPhone/i.test(window.navigator.userAgent);

  appStoreLink.hidden = !isIPhone;
  deviceDetail.textContent = isIPhone
    ? 'Don\'t have TubeBoard yet? Download it, then open this shared link again.'
    : 'This shared live view currently opens in TubeBoard on iPhone. Browser tracking is not available yet.';

  if (result.state === 'valid') {
    status.textContent = `Someone shared a ${result.lineName} line train with you.`;
    detail.textContent = 'TubeBoard checks fresh TfL data to show where this train is and when it is expected at the shared station.';
  } else if (result.state === 'expired') {
    status.textContent = 'This shared train link has expired.';
    detail.textContent = 'Ask the sender to share the train again from a current TubeBoard departure board.';
  } else {
    status.textContent = 'This shared train link cannot be opened.';
    detail.textContent = 'Ask the sender to share the train again from a current TubeBoard departure board.';
  }
}
