import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/message-center/state/message-delivery.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } });
const { deliveryStatus, clearAwaitingAfterGeneratedReply } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const message = { platform_code: 'douyin', message_status: 'queued', raw_payload: {} };
assert.equal(clearAwaitingAfterGeneratedReply(message), false, 'AI generation is not platform delivery');
assert.equal(deliveryStatus(message), 'sending');
assert.equal(clearAwaitingAfterGeneratedReply({ ...message, message_status: 'confirmation_pending' }), false);
assert.equal(clearAwaitingAfterGeneratedReply({ ...message, message_status: 'sent' }), true);
assert.equal(clearAwaitingAfterGeneratedReply({ ...message, platform_code: 'pinduoduo' }), true, 'preserve existing PDD behavior');
const cancelled = { ...message, message_status: 'failed', raw_payload: { send_result: { auto_send_suppressed: true } } };
assert.equal(deliveryStatus(cancelled), 'cancelled', 'persisted cancellation should survive history reload');
assert.equal(deliveryStatus({ ...cancelled, raw_payload: {} }), 'failed', 'platform failure stays distinct');
assert.equal(deliveryStatus({ ...cancelled, message_status: 'sent' }), 'sent', 'delivery overrides stale metadata');
assert.equal(deliveryStatus({ ...cancelled, platform_code: 'pinduoduo' }), 'failed');
console.log('Message delivery: generation, pending, cancellation, failure and platform isolation passed');
