# API and data contract

Local Russian PWA: React TypeScript, Express and Node.js 24 with SQLite. The same Express server serves the API and the production frontend; Docker Compose runs both in one container and persists application data in a named volume.

## Data
All ids strings. camelCase JSON. Dates ISO strings. Roles: master, worker, manager, admin. Status: issued, accepted, queued, rejected, in_progress, paused, completed, ai_review, rework, closed, cancelled. completed is transient but recorded before ai_review. Priority emergency, high, normal, planned. Type planned, unplanned.

User: id,name,login,role,specialty,grade,brigadeId,onShift,avatar (initials). API never returns PIN/hash. Seed users master/1234, worker/1234, manager/1234, admin/1234 (demo only); 2 masters,15 workers.
Catalogs: sites[{id,name}], equipment[{id,name,inventory,siteId,type,criticality}], brigades[{id,name}], faults[{id,code,name,specialty,normHours}], materials[{id,name,unit,normalQuantity}], users.
Order: id,number,title,description,type,siteId,equipmentId,assigneeId,brigadeId?,masterId,priority,status,createdAt,dueAt,startedAt?,completedAt?,closedAt?,normHours,faultId?,comment,version,photos[],completion?,assessment?,events[].
Photo: id,url,kind(before/after),capturedAt,uploadedAt,authorId,hash. New uploads additionally contain optional server-computed signature {algorithm:'hv-dhash128-v1',hash,usable,deviation,mean,aspectRatio}. Clients do not submit or override this evidence; legacy photos may omit it. Exact duplicates fail the rules check. Near perceptual matches only warn with low confidence and require a master's comparison; low-detail/uniform signatures are excluded. This is not defect recognition or proof of capture time.
Event: id,actorId,actorName,action,fromStatus?,toStatus?,at,comment.
completion: works,faultId,materials[{materialId,quantity}],materialsConfirmed,comment,submittedAt. Earlier attempts remain in completionHistory with their evidence and assessment.
assessment: verdict(accepted/remarks/rework),score(1..5),confidence(0..1),summary,checks[{label,status(pass/warn/fail),detail}],strengths[],improvements[],provider,reviewedAt,masterScore?,masterComment?.
Notification: id,userId,orderId?,title,message,kind(info/warning/danger/success),createdAt,read.

## API
All authenticated via HttpOnly same-site cookie. All errors {error:string}. Mutations JSON. API validates authorization server side; workers may only mutate own orders. SSE cookie authentication; do not put session tokens in URLs.
POST /api/auth/login {login,pin} -> {user}; GET /api/auth/me -> {user}; POST /api/auth/logout.
GET /api/bootstrap -> {user,catalogs,orders,notifications,settings:{reminderMinutes,repeatMinutes,aiProvider},serverTime}. Orders includes history (550+) filtered to own for workers.
GET /api/events -> SSE changed event on mutation; frontend reload debounce.
POST /api/orders {title?,description,type,siteId,equipmentId,assigneeId,brigadeId?,priority,dueAt,normHours,faultId?,comment,photoIds?} -> order. The responsible worker receives the notification. If brigadeId is provided, it must match the selected worker's brigade (otherwise 400); an omitted brigade inherits that worker's brigade.
PATCH /api/orders/:id {priority?,assigneeId?,dueAt?,comment?,version?} -> order with audit event.
POST /api/orders/:id/transition {status,reason?,version?} -> order. Worker: issued->accepted/queued/rejected, queued->accepted/rejected, accepted->in_progress, in_progress->paused, paused/rework->in_progress. master->cancelled as appropriate. Prevent concurrent in_progress assignments.
POST /api/orders/:id/complete {works,faultId,materials:[{materialId,quantity}],materialsConfirmed?,comment,photoIds,version?,requestId?} -> order. First submission is in-progress only. Empty required evidence goes through review to rework. Record completed + ai_review; asynchronous assessment -> rework or stays ai_review pending master. requestId supports safe offline retries (see below).
POST /api/orders/:id/review {decision:close/rework,score?,comment,version?} -> order (master only, ai_review with assessment; no bypass before AI; rework returns worker).
POST /api/uploads multipart field photos (max5 images), fields kind,capturedAt?,orderId?,requestId? -> {photos:Photo[]}. Store file locally, validate type/size, re-encode JPEG and remove EXIF; actor-bound upload IDs.
POST /api/notifications/read {ids?:string[]}.
GET /api/push/key -> {publicKey}; POST /api/push/subscribe {subscription}.
GET /api/reports/export?from=&to=&siteId=&equipmentId=&assigneeId=&brigadeId= -> .xlsx via exceljs (orders, ratings, materials).
POST /api/assistant {message} -> {answer,provider} for master/manager/admin. provider is configured-model, demo-rules, or demo-rules (fallback). Calculated database facts remain the answer's authoritative part; a configured LLM may add a separately labelled explanation from redacted context and aggregate evidence. Timeout, malformed or low-confidence output falls back to the explicitly labelled local statistical answer. No mutation tools are available to the assistant.
PATCH /api/settings {reminderMinutes,repeatMinutes} master/admin.
POST /api/catalogs/:kind (sites,equipment,faults,materials,brigades,users) admin; validated data.
PATCH /api/catalogs/:kind/:id admin; validated data, audit entry; PIN or role changes revoke that user's sessions.
GET /api/health -> {ok:true,aiProvider}.

### Activity journal

GET /api/audit?search=&siteId=&equipmentId=&actorId=&from=&to=&kind=&page=1&pageSize=50 -> {items,total,page,pageSize,actors:[{id,name}]}.

Each item is {id,at,actorId,actorName,action,comment,kind,entityLabel?,orderId?,orderNumber?,equipmentId?,equipmentName?,siteId?,siteName?,fromStatus?,toStatus?}. kind is order, catalog or settings. orderNumber is a string. Newest events appear first, with a stable ID tie-breaker. The response combines order.events with stored catalog/settings audit entries; raw record snapshots, PINs and credentials are never exposed. Edits record readable old/new priority, deadline, comment and assignee values; master score overrides are recorded too.

Master/manager/admin see all journal entries. Workers see events only from orders currently assigned to them, matching bootstrap/order access, and cannot retrieve catalog/settings events. actors contains all actors from accessible entries before search/date/actor filtering. page is 1-based and clamped to the last available page (1 when empty); pageSize defaults to 50 and accepts 1–100. Invalid or repeated filter parameters return 400. YYYY-MM-DD from/to select inclusive calendar days in Asia/Qyzylorda (UTC+05:00); explicit ISO timestamps use inclusive from and exclusive to.

### Offline retry protocol

Use a stable UUID requestId for a queued completion. Upload each queued photo with its own stable requestId, such as UUID:0, UUID:1; preserve the file bytes and capturedAt across retries. IndexedDB keeps pending reports and photo blobs until the server confirms submission.

The backend scopes idempotency by operation, actor, order and requestId. A successful repeat returns the originally saved response, including after AI review, a version change or cancellation; it does not create another completion, event or photo. Order visibility is always rechecked. A reused key with changed payload returns 409. Concurrent uploads using the same key share one operation. Completed responses and keys persist in SQLite; the client should refresh bootstrap after confirmation to obtain the current order version/status. Requests without requestId retain the normal version/state checks.

### Automatic weekly summary

At server startup and every minute, the scheduler checks for the previous full Monday–Sunday week in Kostanay time. Master and manager inboxes receive a statistical summary with period counts, calculated downtime and up to four anomaly findings with recommendations. It includes current workload as explicitly current figures. Persistent notificationKeys prevent duplicate delivery per week and recipient, including across restart. A new recipient gets that week's summary on the next sweep. Weekly delivery is internal only: it calls neither an external LLM nor email/push services. No additional endpoint is required; messages arrive in bootstrap.notifications and changes trigger SSE.

### Optional model and image evidence

AI_BASE_URL and AI_MODEL enable the OpenAI-compatible /chat/completions adapter; AI_API_KEY is optional. AI_SEND_PHOTOS=true explicitly opts into external transmission of compressed JPEG evidence. Each image is labelled before/after, and the structured payload reports actual counts. The vision prompt asks for visible equipment consistency, defect changes, new visible damage and visible guards/covers, acknowledging missing views and unverified metadata. An image assessment does not certify safety or authorize operation. With no transmitted images, the server explicitly marks visual review as not performed; local rules check presence, exact hashes, eligible perceptual signatures and claimed metadata, not repair quality. The master retains the final decision.

Frontend derives dashboard, ratings, anomalies, filters from real orders. Analytics sample patterns must be seeded, no invented generated findings.

## Seed storage interface
server/seed.mjs exports createSeed(now=new Date()) -> {users,sites,equipment,brigades,faults,materials,orders}; seed users include pin for backend hashing at import. No SQL dependencies in seed. >=550 historic orders across >=90 days plus active shift. Completed historical orders have events, completion, assessment. Assessment provider 'demo-rules', realistic detail. Include planted repeat faults on conveyor K-3, high hydraulic material usage, post-maintenance failures, rework concentration. Anchor current data to real Date at launch, UI formats Asia/Qyzylorda. Clearly fictional data. No manufactured photos claiming genuine imagery.
