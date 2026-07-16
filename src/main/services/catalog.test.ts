import { describe, expect, it } from 'vitest'
import { CATEGORY_META, getCategoryDefinitions } from './catalog'

describe('cleanup catalog', () => {
  it('has a matching definition for every visible category', () => {
    const definitions = getCategoryDefinitions()
    expect(definitions.map((item) => item.id)).toEqual(CATEGORY_META.map((item) => item.id))
  })

  it('does not select irreversible review categories by default', () => {
    const reviewCategories = CATEGORY_META.filter((item) => item.safety === 'review')
    expect(reviewCategories.length).toBeGreaterThan(0)
    expect(reviewCategories.every((item) => !item.defaultSelected)).toBe(true)
  })

  it('only uses the dedicated cleaner for the recycle bin', () => {
    const special = getCategoryDefinitions().filter((item) => item.specialCleaner)
    expect(special).toHaveLength(1)
    expect(special[0].id).toBe('recycle-bin')
  })
})
