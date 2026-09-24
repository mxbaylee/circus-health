# Server connection and application updates

The connection control between Assistant and appearance reports whether this browser can reach the Circus Health server. It remains available during startup and while profiles are locked. Hover, keyboard focus or a tap reveals details. It does not test internet access, LiteLLM or the selected model.

## Probe and notification behavior

[`connection.ts`](../src/app/data/connection.ts) maintains one application-level monitor outside the profile-keyed interface. Its independent, uncached `GET /api/runtime` request has a five-second timeout. Successful checks normally repeat every 15 seconds; failures back off from two to 30 seconds. Hidden tabs use a 60-second interval. Focus, visibility, online and offline events request another probe. Browser online status is a hint: a local server can remain reachable without internet access.

The control starts at Checking. Successful runtime responses show Connected. Transport failure shows Reconnecting; an HTTP failure or invalid runtime response shows Server unavailable with details. Outage and recovery transitions each produce one notification, rather than one toast per request. Connection notifications are application-scoped; ordinary success notifications retain their profile scope.

## Updates and refreshing

[`createBuildIdentity`](../src/scripts/build-identity.ts) generates one UUID per production build. Vite embeds it in the client and emits `dist/build-info.json`. [`readBuildId`](../src/server/build-identity.ts) loads the manifest once on server startup, and readiness responses include the same ID. Restarting the same built image does not create an update. Missing or invalid IDs are `null` and do not cause mismatch notices.

[`ConnectionNotices`](../src/app/components/ConnectionStatus.tsx) shows a persistent update notice when both IDs are known and differ. Dismissal is held in this tab's memory for that client/server pair; a different build pair produces another notice. There is no automatic refresh.

Refresh is disabled while the shared API has pending mutations or the server is unavailable. The existing [`useProfileTransition`](../src/app/components/ProfileTransitionGuard.tsx) offers Save and continue, Discard and continue, or Back for registered editors with pending work. An unconfirmed save remains pending even if the displayed text was reverted. Save explicitly reconciles the retained operation; Discard discards only unsaved local work and never reverses an accepted version. Failed saves leave the editor available. Existing profile/recovery dialogs block the background refresh control; attachment and history operations retain their existing guards. This feature does not introduce a general draft store for every dialog.

## Read recovery and its limits

[`api`](../src/app/data/api.ts) routes body-free GET requests through [`readWithRecovery`](../src/app/data/read-recovery.ts). Equivalent in-flight reads share a request within the current mutation generation. Transport failures, including body transfer failure, and HTTP 502/503/504 may retry once after a successful independent probe. There are at most 64 shared reads, each bounded to 20 seconds. Cancelled subscribers stop waiting immediately; the underlying request is cancelled when its last subscriber leaves. Profile identity changes cancel scoped requests. Mutations separate generations so a later read cannot join a pre-mutation request.

`useResource` refreshes mounted reads after recovery. It keeps previously loaded data only for the same profile/resource key; changing keys hides the previous resource immediately. `ResourceState` retains content and shows a retry message on a failed refresh. Note editors adopt newer fetched versions only when clean; dirty or uncertain edits retain their form and existing version-conflict behavior.

There is no mutation queue or automatic save replay, and no durable browser queue. Health content can remain in component memory and in-flight response buffers while the tab is open. Direct lifecycle requests, exports, XMLHttpRequest uploads, PDF and assistant streams keep their specialized request paths; the helper does not claim to retry them. Once the bounded attempt fails, the caller still receives an error and owns its save/error presentation. A page refresh, tab close or process loss can discard unsaved local state.

## Verification

The focused [monitor and notice tests](../src/tests/mounted/connection-awareness.test.tsx), [resource/editor recovery tests](../src/tests/mounted/resource-recovery.test.tsx), [build identity tests](../src/server/test/build-identity.test.ts), and [encrypted browser journey](../src/tests/browser/connection-awareness.test.ts) cover probe transitions, update dismissal, cancellation, same-editor preservation, explicit reconciliation of a committed-but-lost save response and guarded discard. The browser test injects controlled transport failures and build mismatches around the actual encrypted application. It does not establish real network/device behavior or model availability. Physical passkeys and real provider/authentication workflows remain separate release checks.

Integration at `ba34f78` passed 260 mounted tests, 57 state tests, 332 backend checks with four optional skips, and three encrypted browser journeys including the shared pickers and People filters. Light/dark desktop/mobile connection layouts were reviewed. The packaged Docker browser bundle, public manifest and runtime response reported the same build ID; an isolated empty container with networking disabled preserved that ID across restart. The built image was also confirmed as the one serving the local preview. See [security](security.md) for the distinction between bounded request counts and uncapped response-buffer bytes, and for the limits of retained offline data.
