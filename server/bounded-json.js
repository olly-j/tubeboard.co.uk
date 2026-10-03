// Private unrun draft. Parse original bounded UTF-8 bytes; duplicate escaped
// property names are duplicates too. Object key order has no authority.
import { TextDecoder } from 'node:util';
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function parseBoundedJSON(bytes, limit = 2_000_000, depthLimit = 64, integerNumbersOnly = false) {
  const body = Buffer.from(bytes);
  if (!body.length || body.length > limit) throw Error('JSON byte bound');
  const text = utf8.decode(body); let offset = 0;
  const white = () => { while (/[\x20\x09\x0a\x0d]/.test(text[offset] || '\u0000')) offset++; };
  const string = () => {
    const begin = offset++; let escaped = false;
    while (offset < text.length) {
      const c = text[offset++];
      if (!escaped && c === '"') return JSON.parse(text.slice(begin, offset));
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    throw Error('JSON string');
  };
  const value = (depth) => {
    if (depth > depthLimit) throw Error('JSON depth bound');
    white(); const c = text[offset];
    if (c === '"') return string();
    if (c === '{') {
      offset++; white(); const object = Object.create(null), keys = new Set();
      if (text[offset] === '}') { offset++; return object; }
      while (offset < text.length) {
        white(); if (text[offset] !== '"') throw Error('JSON key');
        const key = string(); if (keys.has(key)) throw Error('Duplicate JSON key'); keys.add(key);
        white(); if (text[offset++] !== ':') throw Error('JSON colon'); object[key] = value(depth + 1);
        white(); const next = text[offset++]; if (next === '}') return object; if (next !== ',') throw Error('JSON object separator');
      }
      throw Error('JSON object');
    }
    if (c === '[') {
      offset++; white(); const array = []; if (text[offset] === ']') { offset++; return array; }
      while (offset < text.length) { array.push(value(depth + 1)); white(); const next = text[offset++]; if (next === ']') return array; if (next !== ',') throw Error('JSON array separator'); }
      throw Error('JSON array');
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (!token) throw Error('JSON value'); offset += token[0].length;
    if (integerNumbersOnly && !/^-?(?:0|[1-9][0-9]*)$/.test(token[0])) throw Error('JSON integer primitive');
    const number = Number(token[0]); if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)) throw Error('JSON numeric bound');
    return number;
  };
  const result = value(0); white(); if (offset !== text.length) throw Error('JSON trailing bytes'); return result;
}
