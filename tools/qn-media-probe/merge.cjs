'use strict';
const { parseSample } = require('./parse.cjs');

function key(message) { return [message.shopUid, message.cid, message.messageId].join('|'); }

function mergeMediaUpdate(messages, update) {
  if (!update || typeof update !== 'object' || !Number.isInteger(update.index) || update.index < 0)
    throw new Error('invalid media update');
  const id = update.mcode?.messageId;
  if (typeof id !== 'string' || !id) throw new Error('media update missing message ID');
  const target = messages.find(message => message.messageId === id);
  if (!target) return { applied: false, reason: 'message-not-found', messages };
  const sample = { message: target, nativeFields: {}, originalData: { jsview: [{ type: update.update?.type, value: update.update?.value || {} }] } };
  const part = parseSample(sample).parts[0];
  const existingIndex = target.parts.findIndex(item => item.index === update.index);
  if (existingIndex < 0) target.parts.push({ ...part, index: update.index });
  else target.parts[existingIndex] = { ...target.parts[existingIndex], ...part, index: update.index };
  target.parts.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
  return { applied: true, reason: existingIndex < 0 ? 'inserted' : 'updated', messages: [target] };
}

function mergeMessages(messages, additions) {
  const byKey = new Map(messages.map(message => [key(message), message]));
  for (const message of additions) {
    const existing = byKey.get(key(message));
    if (!existing) { byKey.set(key(message), message); continue; }
    existing.parts = message.parts;
    existing.messageKind = message.messageKind;
  }
  return [...byKey.values()];
}

module.exports = { key, mergeMediaUpdate, mergeMessages };
