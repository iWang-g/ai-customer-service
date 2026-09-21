# Native Log Receipt Observation, 2026-09-07

Observation only: 10:08:53 to 10:10:53 Asia/Shanghai, 603163 new app.log bytes,
offsets 20273987 to 20877150. No hook, debugger, task, bridge call or automated
send was used. The existing entry observer does not capture completion callback
arguments, so it was not run or represented as a completion observer.

Account: `3#2222303856223`, shop `有求必应羊羊:王刚`.
Customer: `tb4947894539`, target ID `2214525969878`.
Conversation: `2214525969878.1-2216058631944.1#11001@cntaobao`.

## Observed Sequence

| Local Log Time | Direction | Client ID | Message ID |
| --- | --- | --- | --- |
| 10:10:08 | Outgoing | 7502548731028308036 | 4293759074497.PNM |
| 10:10:16 | Incoming | 7502548766390485070 | 4293737407610.PNM |
| 10:10:24 | Outgoing | 7502548801207402576 | 4293751274194.PNM |

Both outgoing messages have exact text `QN-OUT-20260907-B`, final
`sendStatus=0`, `progress=100`, correct sender/receiver nicknames and cid.
Each appears once in WebEventCenter and once in BridgeChatMsg. These are two
distinct messages with two duplicate log notifications each, not four sends.

Each outgoing clientId is also mapped to its server messageId in
`UpdateMessageWithLocalId` and `rsp SendMessageToPeer!`. Thus final receipts
can be correlated by account, cid and message identifiers without reading
private AppMessage offsets. This does not yet associate an arbitrary future
probe request with a clientId when concurrent identical manual sends occur.

Nearby SDK RPC records for `/r/MessageSend/sendByReceiverScope` use transaction
IDs `005101b1` and `005101b9`, report code 200, unpack success and
`biz_err=(status=-1, scope=AppNet, code=0, ... developMessage=no_error)`.
These are RPC-layer fields, not direct readings of outer ResultCode+8. Timing
and account agree with the sends; do not conflate the RPC mid with messageId
or assert an exact RPC-to-message binding solely from adjacent log lines.

The incoming `OnMessageArrive` and `onShopRobotReceriveNewMsgs.newmsgs` agree on
the customer, shop, cid and message IDs. Incoming body `QN-IN-20260907-B` is
not present in this capture, so its exact text is not verified. A native
`GetNewMsg` invocation appears, but its response body was not captured here.

## Guard Implications

- `account + cid + text + time window` alone is insufficient: this run contains
  two messages with identical text. Preserve all candidates; fail closed as
  ambiguous until a unique clientId binding is established. Never select the
  first matching successful receipt merely because it is convenient.
- Deduplicate notifications by account, cid, clientId and messageId. Preserve
  status transitions; repeated logs do not imply a new send.
- In the incoming event, `latestmsg` references the preceding outgoing
  message `4293759074497.PNM`, not the incoming message. Use `newmsgs` for
  new-message identity and direction.
- Native logs advertise SDK-managed retry settings. Disabling retries in our
  probe does not mean SDK transport retries are disabled; do not alter native
  retry settings as part of this research.

## Remaining Gate

No real ResultCode memory was observed. Direct-send stays disabled. Next work
is to prepare a reviewed completion observer or a strict unique-candidate log
correlator with ambiguity/timeout tests, before requesting another live test.
The production daemon remains unchanged; findings are not claims that its
existing receipt parser has already been hardened.

Evidence under `.tmp/qn-native-submit-probe/`:

- `receipt-observation-2026-09-07T02-08-53-203Z.log`
- corresponding `.log.json` capture metadata
- corresponding `.log.analysis.json` structured analysis, generated using the
  existing receipt parser plus exact account filtering and identifier grouping
- `analyze-receipt-observation-20260907.cjs` assertions for the two distinct
  sends, duplicate counts, final statuses and incoming direction
