/** Public API contract. No credentials or PIN hashes are exposed to the browser. */
export type Role = 'master' | 'worker' | 'manager' | 'admin'
export type OrderStatus = 'issued' | 'accepted' | 'queued' | 'rejected' | 'in_progress' | 'paused' | 'completed' | 'ai_review' | 'rework' | 'closed' | 'cancelled'
export type Priority = 'emergency' | 'high' | 'normal' | 'planned'
export type OrderType = 'planned' | 'unplanned'
export type Verdict = 'accepted' | 'remarks' | 'rework'
export type CheckStatus = 'pass' | 'warn' | 'fail'
export type NotificationKind = 'info' | 'warning' | 'danger' | 'success'
export type PhotoKind = 'before' | 'after'

export interface User {
  id: string
  name: string
  login: string
  role: Role
  specialty: string
  grade: number | null
  brigadeId: string | null
  onShift: boolean
  avatar: string
}

export interface Site { id: string; name: string }
export interface Equipment { id: string; name: string; inventory: string; siteId: string; type: string; criticality: string }
export interface Brigade { id: string; name: string }
export interface Fault { id: string; code: string; name: string; specialty: string; normHours: number }
export interface Material { id: string; name: string; unit: string; normalQuantity: number }
export interface Catalogs { sites: Site[]; equipment: Equipment[]; brigades: Brigade[]; faults: Fault[]; materials: Material[]; users: User[] }

export interface Photo {
  id: string
  url: string
  kind: PhotoKind
  capturedAt: string
  uploadedAt: string
  authorId: string
  hash: string
}

export interface OrderEvent {
  id: string
  actorId: string
  actorName: string
  action: string
  fromStatus?: OrderStatus
  toStatus?: OrderStatus
  at: string
  recordedAt?: string
  effectiveAt?: string
  timeSource?: 'device' | 'server-fallback'
  comment: string
}

export interface MaterialUsage { materialId: string; quantity: number }
export interface Completion { works: string; faultId: string; materials: MaterialUsage[]; materialsConfirmed?: boolean; comment: string; submittedAt: string }
export interface AssessmentCheck { label: string; status: CheckStatus; detail: string }
export interface Assessment {
  verdict: Verdict
  score: number
  confidence: number
  summary: string
  checks: AssessmentCheck[]
  strengths: string[]
  improvements: string[]
  provider: string
  reviewedAt: string
  masterScore?: number
  masterComment?: string
}

export interface CompletionHistoryEntry {
  assigneeId: string
  completion: Completion
  assessment?: Assessment
  completedAt?: string
  photos: Photo[]
  archivedAt: string
  reason: string
}

export interface Order {
  id: string
  number: string | number
  title: string
  description: string
  type: OrderType
  siteId: string
  equipmentId: string
  assigneeId: string
  brigadeId?: string
  masterId: string
  priority: Priority
  status: OrderStatus
  createdAt: string
  queuedAt?: string
  queueSequence?: number
  dueAt: string
  startedAt?: string
  completedAt?: string
  closedAt?: string
  normHours: number
  faultId?: string
  comment: string
  version: number
  photos: Photo[]
  completion?: Completion
  completionHistory?: CompletionHistoryEntry[]
  assessment?: Assessment
  events: OrderEvent[]
}

export interface Notification { id: string; userId: string; orderId?: string; title: string; message: string; kind: NotificationKind; createdAt: string; read: boolean }
export interface Settings { reminderMinutes: number; repeatMinutes: number; aiProvider: string }
export interface BootstrapResponse { user: User; catalogs: Catalogs; orders: Order[]; notifications: Notification[]; settings: Settings; serverTime: string }
export interface ApiError { error: string }
export interface LoginRequest { login: string; pin: string }
export interface AuthResponse { user: User }
export interface CreateOrderRequest {
  title?: string
  description: string
  type: OrderType
  siteId: string
  equipmentId: string
  assigneeId: string
  brigadeId?: string
  priority: Priority
  dueAt: string
  normHours: number
  faultId?: string
  comment: string
  photoIds?: string[]
}
export interface UpdateOrderRequest { priority?: Priority; assigneeId?: string; dueAt?: string; comment?: string; version?: number }
export interface TransitionRequest { status: OrderStatus; reason?: string; version?: number; requestId?: string; ownerId?: string; recordedAt?: string }
export interface CompleteOrderRequest { works: string; faultId: string; materials: MaterialUsage[]; materialsConfirmed?: boolean; comment: string; photoIds: string[]; version?: number; requestId?: string; ownerId?: string; recordedAt?: string }
export interface ReviewOrderRequest { decision: 'close' | 'rework'; score?: number; comment: string; version?: number }
export interface UploadResponse { photos: Photo[] }
export interface AssistantResponse { answer: string }
export interface HealthResponse { ok: boolean; aiProvider: string }
export interface PushKeyResponse { publicKey: string }
export type CatalogKind = 'sites' | 'equipment' | 'faults' | 'materials' | 'brigades' | 'users'

/** Dates are inclusive at the beginning and exclusive at the end. */
export interface DateRange { from?: string | Date; to?: string | Date }
export interface OrderFilters extends DateRange {
  siteId?: string
  equipmentId?: string
  assigneeId?: string
  brigadeId?: string
  priority?: Priority | ''
  status?: OrderStatus | 'overdue' | ''
  type?: OrderType | ''
  search?: string
  dateField?: 'createdAt' | 'completedAt' | 'closedAt'
}
