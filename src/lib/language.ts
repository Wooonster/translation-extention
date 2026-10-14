export type SelectionLanguage = 'zh' | 'other' | 'unknown'

export const detectSelectionLanguage = (text: string): SelectionLanguage => {
  const normalized = String(text ?? '').trim()
  if (!normalized) return 'unknown'

  const cjkCount = (normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  const latinCount = (normalized.match(/[A-Za-z]/g) || []).length
  const kanaCount = (normalized.match(/[\u3040-\u30ff]/g) || []).length
  const hangulCount = (normalized.match(/[\uac00-\ud7af]/g) || []).length
  const cyrillicCount = (normalized.match(/[\u0400-\u04ff]/g) || []).length
  const arabicCount = (normalized.match(/[\u0600-\u06ff]/g) || []).length
  const devanagariCount = (normalized.match(/[\u0900-\u097f]/g) || []).length

  const nonChineseLetterCount = latinCount + kanaCount + hangulCount + cyrillicCount + arabicCount + devanagariCount
  const totalLetterLikeCount = cjkCount + nonChineseLetterCount

  if (cjkCount === 0) return 'other'
  if (nonChineseLetterCount === 0) return 'zh'
  if (totalLetterLikeCount === 0) return 'unknown'

  return cjkCount / totalLetterLikeCount >= 0.6 ? 'zh' : 'other'
}

export interface VocabularyToken {
  text: string
  selectable: boolean
  index: number
}

export function segmentVocabularyText(text: string): VocabularyToken[] {
  const source = String(text ?? '')
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(vocabularySegmenterLocale(source), { granularity: 'word' })
      return Array.from(segmenter.segment(source), (segment, index) => ({
        text: segment.segment,
        selectable: Boolean(segment.isWordLike) && /[\p{L}\p{N}]/u.test(segment.segment),
        index,
      }))
    } catch {
      // Segmenter can reject an unsupported locale. Whitespace splitting still selects words.
    }
  }

  return source
    .split(/(\s+)/)
    .filter(part => part.length > 0)
    .map((part, index) => ({
      text: part,
      selectable: /\S/.test(part) && /[\p{L}\p{N}]/u.test(part),
      index,
    }))
}

export function isSingleVocabularyWord(text: string): boolean {
  return segmentVocabularyText(text).filter(token => token.selectable).length === 1
}

export function phraseFromTokenSelection(tokens: VocabularyToken[], selected: Iterable<number>): string {
  const chosen = new Set(selected)
  let phrase = ''
  let previous: number | null = null
  for (const token of tokens) {
    if (!token.selectable || !chosen.has(token.index)) continue
    if (previous == null) {
      phrase = token.text
    } else {
      const between = tokens.slice(previous + 1, token.index)
      const skippedWord = between.some(item => item.selectable)
      phrase += skippedWord ? ` ${token.text}` : `${between.map(item => item.text).join('')}${token.text}`
    }
    previous = token.index
  }
  return phrase.replace(/\s+/g, ' ').trim()
}

function vocabularySegmenterLocale(text: string): string | undefined {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  return undefined
}

export const shouldSkipFloatingTranslation = (text: string, userLanguage = 'zh'): boolean => {
  const normalized = String(text ?? '').trim()
  if (!normalized) return true
  if (userLanguage !== 'zh') return false
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(normalized)) return true
  return detectSelectionLanguage(normalized) === 'zh'
}
