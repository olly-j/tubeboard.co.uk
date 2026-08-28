const schemaVersion = 1;
const maximumFragmentLength = 2048;
const maximumDecodedBytes = 1024;
const maximumLifetimeSeconds = 45 * 60;
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
  if (selection.version !== schemaVersion || !lineNames.has(selection.lineID)) return false;
  if (!validIdentifier(selection.lineID, 64)
      || !validIdentifier(selection.vehicleID, 96)
      || !validIdentifier(selection.sourceStationID, 96)
      || !validIdentifier(selection.sourcePredictionID, 128)
      || !validTimestamp(selection.expectedArrival)) return false;
  if (selection.destinationStationID != null
      && !validIdentifier(selection.destinationStationID, 96)) return false;
  if (selection.direction != null && !validText(selection.direction, 32)) return false;
  if (!Number.isSafeInteger(selection.issuedAtSeconds)
      || !Number.isSafeInteger(selection.expiresAtSeconds)
      || selection.expiresAtSeconds <= selection.issuedAtSeconds
      || selection.expiresAtSeconds - selection.issuedAtSeconds > maximumLifetimeSeconds) return false;
  return true;
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
  const result = decodeTrainSelection(window.location.hash.slice(1));

  if (result.state === 'valid') {
    status.textContent = `${result.lineName} line train link ready.`;
    detail.textContent = 'Install or open TubeBoard, then use this same link. The app will re-check the selected working against fresh TfL predictions before showing its remaining calls.';
  } else if (result.state === 'expired') {
    status.textContent = 'This shared train link has expired.';
    detail.textContent = 'Return to a current TubeBoard departure board and share the train again. An expired link never falls back to a different working.';
  } else {
    status.textContent = 'This shared train link is incomplete or unsupported.';
    detail.textContent = 'TubeBoard has not used the selection. Ask the sender to share the train again from a current departure board.';
  }
}
