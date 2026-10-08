# API and data contract

Local Russian PWA: React TypeScript, Express and Node.js 24 with SQLite. The same Express server serves the API and the production frontend; Docker Compose runs both in one container and persists application data in a named volume.

## Data
All ids strings. camelCase JSON. Dates ISO strings. Roles: master, worker, manager, admin. Status: issued, accepted, queued, rejected, in_progress, paused, completed, ai_review, rework, closed, cancelled. completed is transient but recorded before ai_review. Priority emergency, high, normal, planned. Type planned, unplanned.

User: id,name,login,role,specialty,grade,brigadeId,onShift,avatar (initials). API never returns PIN/hash. Seed users master/1234, worker/1234, manager/1234, admin/1234 (demo only); 2 masters,15 workers.
Catalogs: sites[{id,name}], equipment[{id,name,inventory,siteId,type,criticality}], brigades[{id,name}], faults[{id,code,name,specialty,normHours}], materials[{id,name,unit,normalQuantity}], users.
Order: id,number,title,description,type,siteId,equipmentId,assigneeId,brigadeId?,masterId,priority,status,createdAt,dueAt,startedAt?,completedAt?,closedAt?,normHours,faultId?,comment,version,photos[],completion?,assessment?,events[].
Photo: id,url,kind(before/after),capturedAt,uploadedAt,authorId,hash.
Event: id,actorId,actorName,action,fromStatus?,toStatus?,at,comment.
completion: works,faultId,materials[{materialId,quantity}],comment,submittedAt.
assessment: verdict(accepted/remarks/rework),score(1..5),confidence(0..1),summary,checks[{label,status(pass/warn/fail),detail}],strengths[],improvements[],provider,reviewedAt,masterScore?,masterComment?.
Notification: id,userId,orderId?,title,message,kind(info/warning/danger/success),createdAt,read.

## API
All authenticated via HttpOnly same-site cookie. All errors {error:string}. Mutations JSON. API validates authorization server side; workers may only mutate own orders. SSE cookie authentication; do not put session tokens in URLs.
POST /api/auth/login {login,pin} -> {user}; GET /api/auth/me -> {user}; POST /api/auth/logout.
GET /api/bootstrap -> {user,catalogs,orders,notifications,settings:{reminderMinutes,repeatMinutes,aiProvider},serverTime}. Orders includes history (550+) filtered to own for workers.
GET /api/events -> SSE changed event on mutation; frontend reload debounce.
POST /api/orders {title?,description,type,siteId,equipmentId,assigneeId,brigadeId?,priority,dueAt,normHours,faultId?,comment,photoIds?} -> order.
PATCH /api/orders/:id {priority?,assigneeId?,dueAt?,comment?,version?} -> order with audit event.
POST /api/orders/:id/transition {status,reason?,version?} -> order. Worker: issued->accepted/queued/rejected, queued->accepted/rejected, accepted->in_progress, in_progress->paused, paused/rework->in_progress. master->cancelled as appropriate. Prevent concurrent in_progress assignments.
POST /api/orders/:id/complete {works,faultId,materials:[{materialId,quantity}],comment,photoIds,version?} -> order. In progress only. Empty required evidence should go through review to rework (demo requirement). Record completed + ai_review; asynchronous assessment -> rework or stays ai_review pending master.
POST /api/orders/:id/review {decision:close/rework,score?,comment,version?} -> order (master only, ai_review with assessment; no bypass before AI; rework returns worker).
POST /api/uploads multipart field photos (max5 images), fields kind,capturedAt,orderId? -> {photos:Photo[]}. Store file locally, validate type/size; actor-bound upload IDs.
POST /api/notifications/read {ids?:string[]}.
GET /api/push/key -> {publicKey}; POST /api/push/subscribe {subscription}.
GET /api/reports/export?from=&to=&siteId=&equipmentId=&assigneeId=&brigadeId= -> .xlsx via exceljs (orders, ratings, materials).
POST /api/assistant {message} -> {answer} grounded summary (statistical mode label).
PATCH /api/settings {reminderMinutes,repeatMinutes} master/admin.
POST /api/catalogs/:kind (sites,equipment,faults,materials,brigades,users) admin; validated data.
GET /api/health -> {ok:true,aiProvider}.

Frontend derives dashboard, ratings, anomalies, filters from real orders. Analytics sample patterns must be seeded, no invented generated findings.

## Seed storage interface
server/seed.mjs exports createSeed(now=new Date()) -> {users,sites,equipment,brigades,faults,materials,orders}; seed users include pin for backend hashing at import. No SQL dependencies in seed. >=550 historic orders across >=90 days plus active shift. Completed historical orders have events, completion, assessment. Assessment provider 'demo-rules', realistic detail. Include planted repeat faults on conveyor K-3, high hydraulic material usage, post-maintenance failures, rework concentration. Anchor current data to real Date at launch, UI formats Asia/Qyzylorda. Clearly fictional data. No manufactured photos claiming genuine imagery.
