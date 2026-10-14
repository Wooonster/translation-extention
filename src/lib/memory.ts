import { isSingleVocabularyWord } from './language'

export const MEMORY_STORAGE_KEY = 'floatorMemory'
export const MEMORY_VERSION = 1

export const REVIEW_COUNT_THRESHOLD = 10
export const REVIEW_AGED_COUNT = 5
export const REVIEW_AGED_MS = 7 * 24 * 60 * 60 * 1000

export type VocabStatus = 'pending' | 'ready' | 'error'

export interface VocabSource {
  url: string
  title: string
  sentence: string
  addedAt: string
}

export interface VocabEntry {
  id: string
  word: string
  ipa: string
  translation: string
  userTranslation: string
  explanation: string
  sourceSentence: string
  sourceUrl: string
  sourceTitle: string
  createdAt: string
  lastAddedAt: string
  addCount: number
  sources: VocabSource[]
  partOfSpeech: string
  status: VocabStatus
}

export interface VocabSummary {
  id: string
  createdAt: string
  text: string
  entryIds: string[]
}

export interface VocabReview {
  newSinceSummary: number
  lastSummaryAt: string | null
  latestSummary: VocabSummary | null
  snoozeUntilNewSave: boolean
  oldestUnreviewedAt: string | null
  summaryDismissedFor: string | null
}

export interface FloatorMemory {
  version: 1
  entries: VocabEntry[]
  review: VocabReview
}

export interface SaveVocabInput {
  word: string
  sourceSentence: string
  sourceUrl: string
  sourceTitle: string
}

const STATUSES = new Set<VocabStatus>(['pending', 'ready', 'error'])

export function emptyReview(): VocabReview {
  return {
    newSinceSummary: 0,
    lastSummaryAt: null,
    latestSummary: null,
    snoozeUntilNewSave: false,
    oldestUnreviewedAt: null,
    summaryDismissedFor: null,
  }
}

export function emptyMemory(): FloatorMemory {
  return {
    version: MEMORY_VERSION,
    entries: [],
    review: emptyReview(),
  }
}

export function normalizeWord(word: string): string {
  const source = typeof word === 'string' ? word : ''
  let normalized = source
  try {
    normalized = source.normalize('NFC')
  } catch {
    normalized = source
  }
  return normalized.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function isReviewThresholdMet(memory: FloatorMemory, now = Date.now()): boolean {
  const count = memory?.review?.newSinceSummary
  if (!Number.isFinite(count) || count <= 0) return false
  if (count >= REVIEW_COUNT_THRESHOLD) return true
  if (count < REVIEW_AGED_COUNT) return false
  const started = Date.parse(memory.review.oldestUnreviewedAt ?? '')
  if (!Number.isFinite(started)) return false
  return now - started >= REVIEW_AGED_MS
}

export function shouldShowReviewNotice(memory: FloatorMemory, now = Date.now()): boolean {
  return isReviewThresholdMet(memory, now) && memory.review.snoozeUntilNewSave !== true
}

export function dedupeEntries(entries: VocabEntry[]): VocabEntry[] {
  const seen = new Map<string, number>()
  const result: VocabEntry[] = []

  for (const entry of entries) {
    const key = normalizeWord(entry.word)
    if (!key) continue
    const index = seen.get(key)
    if (index == null) {
      seen.set(key, result.length)
      result.push(entry)
      continue
    }
    result[index] = mergeEntries(result[index], entry)
  }

  return rankEntries(result)
}

export function rankEntries(entries: VocabEntry[]): VocabEntry[] {
  return entries.slice().sort(compareEntries)
}

export function dismissSummaryNotice(memory: FloatorMemory): FloatorMemory {
  const episode = memory.review.oldestUnreviewedAt
  if (!episode || memory.review.summaryDismissedFor === episode) return memory
  return {
    ...memory,
    review: {
      ...memory.review,
      summaryDismissedFor: episode,
    },
  }
}

export function upsertPendingEntry(
  memory: FloatorMemory,
  input: SaveVocabInput,
  now = new Date()
): { memory: FloatorMemory; entry: VocabEntry } | null {
  const word = collapseWhitespace(input.word)
  if (!normalizeWord(word)) return null

  const sourceSentence = trimEdges(input.sourceSentence) || word
  const sourceUrl = trimEdges(input.sourceUrl)
  const sourceTitle = trimEdges(input.sourceTitle)
  const nowIso = now.toISOString()
  const key = normalizeWord(word)
  const existing = memory.entries.find(entry => normalizeWord(entry.word) === key)

  const source: VocabSource = {
    url: sourceUrl,
    title: sourceTitle,
    sentence: sourceSentence,
    addedAt: nowIso,
  }
  const sources = addSource(existing?.sources ?? [], source)
  const entry: VocabEntry = existing
    ? {
        ...existing,
        word,
        sourceSentence: sourceSentence || existing.sourceSentence,
        sourceUrl: sourceUrl || existing.sourceUrl,
        sourceTitle: sourceTitle || existing.sourceTitle,
        lastAddedAt: nowIso,
        addCount: readCount(existing) + 1,
        sources,
        partOfSpeech: isSingleVocabularyWord(word) ? existing.partOfSpeech || '' : '',
        status: 'pending',
      }
    : {
        id: createId(),
        word,
        ipa: '',
        translation: '',
        userTranslation: '',
        explanation: '',
        sourceSentence,
        sourceUrl,
        sourceTitle,
        createdAt: nowIso,
        lastAddedAt: nowIso,
        addCount: 1,
        sources,
        partOfSpeech: '',
        status: 'pending',
      }

  const rest = memory.entries.filter(item => item.id !== entry.id && normalizeWord(item.word) !== key)
  const review = noteSave(memory.review, nowIso)

  return {
    entry,
    memory: {
      ...memory,
      version: MEMORY_VERSION,
      entries: rankEntries([entry, ...rest]),
      review,
    },
  }
}

export function snoozeReview(memory: FloatorMemory): FloatorMemory {
  return {
    ...memory,
    review: {
      ...memory.review,
      snoozeUntilNewSave: true,
    },
  }
}

export function deleteEntry(memory: FloatorMemory, id: string): FloatorMemory {
  return {
    ...memory,
    entries: memory.entries.filter(entry => entry.id !== id),
  }
}

export function markEntryReady(
  memory: FloatorMemory,
  id: string,
  fields: { ipa?: string; translation?: string; userTranslation?: string; explanation?: string; partOfSpeech?: string }
): { memory: FloatorMemory; entry: VocabEntry | null } {
  return patchEntry(memory, id, current => {
    const singleWord = isSingleVocabularyWord(current.word)
    const nextPart = collapseWhitespace(fields.partOfSpeech ?? '')
    return {
      ...current,
      ipa: collapseWhitespace(fields.ipa ?? '') || current.ipa,
      translation: collapseWhitespace(fields.translation ?? '') || current.translation,
      userTranslation: collapseWhitespace(fields.userTranslation ?? '') || current.userTranslation,
      explanation: trimEdges(fields.explanation ?? '') || current.explanation,
      partOfSpeech: singleWord ? nextPart || current.partOfSpeech : '',
      status: 'ready',
    }
  })
}

export function markEntryError(memory: FloatorMemory, id: string): { memory: FloatorMemory; entry: VocabEntry | null } {
  return patchEntry(memory, id, current => ({
    ...current,
    status: 'error',
  }))
}

export function clearSummary(memory: FloatorMemory): FloatorMemory {
  if (!memory.review.latestSummary) return memory
  return {
    ...memory,
    review: {
      ...memory.review,
      latestSummary: null,
    },
  }
}

export function applySummary(
  memory: FloatorMemory,
  text: string,
  entryIds: string[],
  now = new Date()
): { memory: FloatorMemory; summary: VocabSummary } {
  const createdAt = now.toISOString()
  const summary: VocabSummary = {
    id: createId(),
    createdAt,
    text: trimEdges(text),
    entryIds: entryIds.filter(id => typeof id === 'string' && id),
  }

  return {
    summary,
    memory: {
      ...memory,
      review: {
        ...memory.review,
        newSinceSummary: 0,
        lastSummaryAt: createdAt,
        latestSummary: summary,
        snoozeUntilNewSave: false,
        oldestUnreviewedAt: null,
      },
    },
  }
}

export function entriesForSummary(memory: FloatorMemory, limit = 50): VocabEntry[] {
  const entries = memory.entries
  if (!entries.length) return []
  const cap = Math.max(1, Math.floor(limit))
  const byRecent = rankByRecentAdd(entries)
  if (memory.review.newSinceSummary <= 0) return byRecent.slice(0, cap)

  const sinceMs = Date.parse(memory.review.oldestUnreviewedAt ?? '')
  const fresh = Number.isFinite(sinceMs) ? byRecent.filter(entry => addedTime(entry) >= sinceMs) : []
  if (fresh.length) return fresh.slice(0, cap)

  const count = Math.min(byRecent.length, Math.max(1, Math.floor(memory.review.newSinceSummary)))
  return byRecent.slice(0, Math.min(cap, count))
}

export function sanitizeMemory(raw: unknown): FloatorMemory {
  if (!raw || typeof raw !== 'object') return emptyMemory()
  const obj = raw as Partial<FloatorMemory>
  const entries = Array.isArray(obj.entries) ? dedupeEntries(obj.entries.map(sanitizeEntry).filter((entry): entry is VocabEntry => Boolean(entry))) : []
  return {
    version: MEMORY_VERSION,
    entries: uniqueEntryIds(entries),
    review: sanitizeReview(obj.review),
  }
}

export function serializeMemory(memory: FloatorMemory): string {
  return JSON.stringify(sanitizeMemory(memory), null, 2)
}

export async function loadMemory(): Promise<FloatorMemory> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return emptyMemory()
    const result = await chrome.storage.local.get(MEMORY_STORAGE_KEY)
    return sanitizeMemory(result?.[MEMORY_STORAGE_KEY])
  } catch {
    return emptyMemory()
  }
}

export async function saveMemory(memory: FloatorMemory): Promise<FloatorMemory> {
  const clean = sanitizeMemory(memory)
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return clean
  await chrome.storage.local.set({ [MEMORY_STORAGE_KEY]: clean })
  return clean
}

function noteSave(review: VocabReview, nowIso: string): VocabReview {
  const count = review.newSinceSummary > 0 ? Math.floor(review.newSinceSummary) : 0
  return {
    ...review,
    newSinceSummary: count + 1,
    snoozeUntilNewSave: false,
    oldestUnreviewedAt: count === 0 ? nowIso : review.oldestUnreviewedAt,
  }
}

function patchEntry(
  memory: FloatorMemory,
  id: string,
  update: (current: VocabEntry) => VocabEntry
): { memory: FloatorMemory; entry: VocabEntry | null } {
  const index = memory.entries.findIndex(entry => entry.id === id)
  if (index < 0) return { memory, entry: null }
  const entry = update(memory.entries[index])
  const entries = memory.entries.slice()
  entries[index] = entry
  return { memory: { ...memory, entries }, entry }
}

function mergeEntries(kept: VocabEntry, incoming: VocabEntry): VocabEntry {
  const keptAdded = addedTime(kept)
  const incomingAdded = addedTime(incoming)
  const incomingIsNewer = incomingAdded >= keptAdded
  const newer = incomingIsNewer ? incoming : kept
  const older = incomingIsNewer ? kept : incoming
  const sources = incoming.sources.reduce((list, source) => addSource(list, source), kept.sources.slice())
  const createdAt = isParseableDate(older.createdAt) ? older.createdAt : newer.createdAt
  return {
    id: kept.id,
    word: newer.word || older.word,
    ipa: newer.ipa || older.ipa,
    translation: newer.translation || older.translation,
    userTranslation: newer.userTranslation || older.userTranslation,
    explanation: newer.explanation || older.explanation,
    sourceSentence: newer.sourceSentence || older.sourceSentence,
    sourceUrl: newer.sourceUrl || older.sourceUrl,
    sourceTitle: newer.sourceTitle || older.sourceTitle,
    createdAt,
    lastAddedAt: newer.lastAddedAt || older.lastAddedAt || createdAt,
    addCount: readCount(kept) + readCount(incoming),
    sources,
    partOfSpeech: isSingleVocabularyWord(newer.word || older.word)
      ? newer.partOfSpeech || older.partOfSpeech
      : '',
    status: newer.status,
  }
}

function sanitizeEntry(raw: unknown): VocabEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<VocabEntry>
  const word = collapseWhitespace(typeof obj.word === 'string' ? obj.word : '')
  if (!normalizeWord(word)) return null
  const createdAt = isParseableDate(obj.createdAt) ? String(obj.createdAt) : new Date(0).toISOString()
  const status = STATUSES.has(obj.status as VocabStatus) ? (obj.status as VocabStatus) : 'pending'
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `legacy:${normalizeWord(word)}:${createdAt}`
  const sourceSentence = trimEdges(typeof obj.sourceSentence === 'string' ? obj.sourceSentence : '')
  const sourceUrl = trimEdges(typeof obj.sourceUrl === 'string' ? obj.sourceUrl : '')
  const sourceTitle = trimEdges(typeof obj.sourceTitle === 'string' ? obj.sourceTitle : '')
  const lastAddedAt = isParseableDate(obj.lastAddedAt) ? String(obj.lastAddedAt) : createdAt
  const sources = addSource(sanitizeSources(obj.sources), {
    url: sourceUrl,
    title: sourceTitle,
    sentence: sourceSentence,
    addedAt: createdAt,
  })
  return {
    id,
    word,
    ipa: collapseWhitespace(typeof obj.ipa === 'string' ? obj.ipa : ''),
    translation: collapseWhitespace(typeof obj.translation === 'string' ? obj.translation : ''),
    userTranslation: collapseWhitespace(typeof obj.userTranslation === 'string' ? obj.userTranslation : ''),
    explanation: trimEdges(typeof obj.explanation === 'string' ? obj.explanation : ''),
    sourceSentence,
    sourceUrl,
    sourceTitle,
    createdAt,
    lastAddedAt,
    addCount: readCount(obj),
    sources,
    partOfSpeech: isSingleVocabularyWord(word)
      ? collapseWhitespace(typeof obj.partOfSpeech === 'string' ? obj.partOfSpeech : '')
      : '',
    status,
  }
}

function sanitizeReview(raw: unknown): VocabReview {
  if (!raw || typeof raw !== 'object') return emptyReview()
  const obj = raw as Partial<VocabReview>
  const count = Number(obj.newSinceSummary)
  return {
    newSinceSummary: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    lastSummaryAt: isParseableDate(obj.lastSummaryAt) ? String(obj.lastSummaryAt) : null,
    latestSummary: sanitizeSummary(obj.latestSummary),
    snoozeUntilNewSave: obj.snoozeUntilNewSave === true,
    oldestUnreviewedAt: isParseableDate(obj.oldestUnreviewedAt) ? String(obj.oldestUnreviewedAt) : null,
    summaryDismissedFor: isParseableDate(obj.summaryDismissedFor) ? String(obj.summaryDismissedFor) : null,
  }
}

function sanitizeSummary(raw: unknown): VocabSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<VocabSummary>
  const text = trimEdges(typeof obj.text === 'string' ? obj.text : '')
  if (!text) return null
  const createdAt = isParseableDate(obj.createdAt) ? String(obj.createdAt) : new Date(0).toISOString()
  const entryIds = Array.isArray(obj.entryIds) ? obj.entryIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : []
  return {
    id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `summary:${createdAt}`,
    createdAt,
    text,
    entryIds,
  }
}

function uniqueEntryIds(entries: VocabEntry[]): VocabEntry[] {
  const used = new Set<string>()
  return entries.map(entry => {
    if (!used.has(entry.id)) {
      used.add(entry.id)
      return entry
    }
    let next = `${entry.id}:${used.size}`
    while (used.has(next)) next = `${next}:1`
    used.add(next)
    return { ...entry, id: next }
  })
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `vocab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function trimEdges(value: string): string {
  return value.replace(/^\s+/, '').replace(/\s+$/, '')
}

function isParseableDate(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value))
}

function readCount(entry: { addCount?: unknown }): number {
  const count = Number(entry.addCount)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.floor(count)
}

function addedTime(entry: Pick<VocabEntry, 'lastAddedAt' | 'createdAt'>): number {
  const parsed = Date.parse(entry.lastAddedAt || entry.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function compareEntries(a: VocabEntry, b: VocabEntry): number {
  const countDiff = readCount(b) - readCount(a)
  if (countDiff) return countDiff
  return addedTime(b) - addedTime(a)
}

function rankByRecentAdd(entries: VocabEntry[]): VocabEntry[] {
  return entries.slice().sort((a, b) => addedTime(b) - addedTime(a))
}

function canonicalUrl(value: string): string {
  const trimmed = trimEdges(value)
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    url.hash = ''
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return trimmed
  }
}

function sameSourceUrl(left: string, right: string): boolean {
  const a = canonicalUrl(left)
  const b = canonicalUrl(right)
  return a.length > 0 && a === b
}

function combineSentences(current: string, incoming: string): string {
  const left = trimEdges(current)
  const right = trimEdges(incoming)
  if (!left) return right
  if (!right || left === right || left.includes(right)) return left
  if (right.includes(left)) return right
  return `${left}\n${right}`
}

function addSource(sources: VocabSource[], incoming: VocabSource): VocabSource[] {
  const url = trimEdges(incoming.url)
  const title = trimEdges(incoming.title)
  const sentence = trimEdges(incoming.sentence)
  const addedAt = isParseableDate(incoming.addedAt) ? incoming.addedAt : new Date(0).toISOString()
  if (!url && !title && !sentence) return sources

  if (url) {
    const index = sources.findIndex(source => sameSourceUrl(source.url, url))
    if (index >= 0) {
      const current = sources[index]
      const next = sources.slice()
      next[index] = {
        url: current.url || url,
        title: current.title || title,
        sentence: combineSentences(current.sentence, sentence),
        addedAt: current.addedAt || addedAt,
      }
      return next
    }
    return [...sources, { url, title, sentence, addedAt }]
  }

  if (sentence && sources.some(source => !trimEdges(source.url) && source.sentence === sentence)) return sources
  if (!sentence) return sources
  return [...sources, { url: '', title, sentence, addedAt }]
}

function sanitizeSources(raw: unknown): VocabSource[] {
  if (!Array.isArray(raw)) return []
  return raw.reduce<VocabSource[]>((list, item) => {
    if (!item || typeof item !== 'object') return list
    const source = item as Partial<VocabSource>
    return addSource(list, {
      url: typeof source.url === 'string' ? source.url : '',
      title: typeof source.title === 'string' ? source.title : '',
      sentence: typeof source.sentence === 'string' ? source.sentence : '',
      addedAt: typeof source.addedAt === 'string' ? source.addedAt : '',
    })
  }, [])
}
