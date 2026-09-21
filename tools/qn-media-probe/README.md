# Independent Qianniu Media Inspection

This research probe reads existing history for the fixed authorized test account and conversation in `inspect.js`. It calls only `im.singlemsg.GetLocalHisMsg`, once per explicitly armed job. It does not switch conversations, write to the input box, send messages, or replace global SDK callbacks. The production reader, mapper, and send chain are unchanged.

It retains three known historical samples and at most one incoming text control. The output contains normalized identity fields, native field names, type/status metadata, and the selected messages' `originalData`. Unknown types remain unclassified. Missing samples are reported explicitly. Account and current conversation are checked before and after reading.

## Operation

```powershell
node tools/qn-media-probe/server.cjs --prepare
powershell -NoProfile -ExecutionPolicy Bypass -File tools/qn-media-probe/install.ps1
node tools/qn-media-probe/server.cjs
```

The server binds to `127.0.0.1:18085` and starts disarmed. Restart Qianniu to load the independent page block, then run:

```powershell
node tools/qn-media-probe/client.cjs status
node tools/qn-media-probe/client.cjs read
```

The `read` command requires exactly one ready page for the test shop. Each job is delivered once; delivery retries do not repeat the native query. Inspect status after a timeout, rather than blindly retrying.

Local config, ZIP backups, and bounded sample results live under `.tmp/qn-media-probe/` (ignored by Git). Sample files can include message bodies and media URLs. Do not publish them as fixtures. Authentication tokens are not printed by the CLI.

To remove only this probe's resource block, run `install.ps1 -Remove`, then reload the page. Stop its Node receiver as well. The existing message hook and order probe are preserved.

## Verification

```powershell
node --test tools/qn-media-probe/*.test.cjs tools/qn-read-messages.test.cjs
```

## Parse Captured Samples

```powershell
node tools/qn-media-probe/parse.cjs .tmp/qn-media-probe/<job-id>.json .tmp/qn-media-probe/parsed-<job-id>.json
```

This offline parser preserves an ordered `parts` array using the observed JSView node types: 0 for text, 1/5 for recognized Taobao item links before/after enrichment, and 7 for images. These are node types, not global message types. Empty native data and unknown nodes remain `unsupported`. A plain text URL is retained as text; an item link with metadata is distinguished from one without it. Price is a display value, not a transaction amount.

The CLI verifies referenced cache files under the allowed `msgImage` directory and prints a limited summary. Original sample and parsed files may contain message bodies and media references. The parser does not download remote URLs automatically. File extension, declared image size and the actual response format/size can differ.

Two live historical reads on 2026-09-09 returned identical samples while a different conversation was selected. Local and remote image bytes and the product thumbnail decoded successfully. This proves reading previously enriched history without selecting the target; it does not yet prove media enrichment for newly arriving messages in an unopened conversation. The production mapper and reader are unchanged, and this probe does not subscribe to live media updates.

## New Message Observation (Page v2)

The v2 page accepts one to six explicit message IDs within the same fixed shop and CID. Such reads require the target conversation to be unselected. The receiver rejects new-ID jobs on v1 pages. Historical sample commands remain compatible with v1 output. Native `templateId` metadata is now retained when present.

After installing v2 and reloading Qianniu, keep a different conversation selected and run:

```powershell
node tools/qn-media-probe/observe.cjs 120000
```

Wait for `observer_started` before sending test images/product shares. The observer starts at the end of `app.log`, filters incoming events to the authorized buyer/shop/CID, and requests history for newly observed IDs. It makes at most three serial reads per message, scheduled on arrival and around 3 and 10 seconds after local observation (queue/bridge latency may delay them). At most six new messages are tracked per run. It also records matching `im.media.onJSViewUpdate` log events without registering a new native event handler. Duplicate log updates are deduplicated by content hash; this is capture deduplication, not a production message merge policy.

The observer fails when the loaded page, selected context, or log file changes. The deadline bounds new work; an already-running read may finish afterward. Results, timings, and context checks are saved under `.tmp/qn-media-probe/live-*/`. It never sends messages or opens the target conversation. Newly received raw samples still require inspection before concluding background media enrichment works.

`merge.cjs` is the independent merge model: message identity is `shopUid|cid|messageId`; a media update uses the same message ID plus node `index`; repeated updates replace the same part and do not append a second message. The observed `templateId=129` companion is classified as `system` and remains separate from the product message.

On 2026-09-09, a 120-second live run captured one image and two product shares with the target unselected throughout the observed period. The image URL was readable on the first query, then its cache reference arrived. Product nodes changed from type 1 (link/ID) to type 5 (title/image/price); matching log updates were observed. Each product share was accompanied by a separate template-129 message with empty original data, which remains unsupported. This does not prove a never-before-opened/new conversation behaves identically, nor that enrichment occurs without history reads.

Use `analyze-live.cjs <events.ndjson> <summary.json>` to reparse captured raw results with the current parser, correlate updates only to new message IDs, and verify every read's before/after state against the run baseline. The original observer records are retained unchanged, including classifications from the parser version that ran at capture time.
