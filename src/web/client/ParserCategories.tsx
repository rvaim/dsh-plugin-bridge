import type { ResolveText } from './types.js'
import type { CategoryInventory, Translate } from './panel-model.js'
import css from './PluginBridgePanel.module.css'

interface ParserCategoriesProps {
  categories: readonly CategoryInventory[]
  total: number
  selectedId: string | null
  onSelect(id: string | null): void
  resolveText: ResolveText
  t: Translate
}

/** Both layouts consume the same catalog, including registered empty categories. */
export function ParserCategories({ categories, total, selectedId, onSelect, resolveText, t }: ParserCategoriesProps) {
  return <div className={css.categoryControls}>
    <nav className={css.categoryRail} aria-label={t('categoryLabel')}>
      <h2 className={css.categoryHeading}>{t('categoryLabel')}</h2>
      <ul className={css.categoryList}>
        <li><button type="button" className={css.categoryButton} aria-current={selectedId === null ? 'page' : undefined}
          onClick={() => { onSelect(null) }}><span>{t('categoryAll')}</span><span className={css.categoryCount}>{total}</span></button></li>
        {categories.map(category => <li key={category.id}>
          <button type="button" className={css.categoryButton} aria-current={selectedId === category.id ? 'page' : undefined}
            onClick={() => { onSelect(category.id) }}>
            <span>{resolveText(category.label)}</span><span className={css.categoryCount}>{category.count}</span>
          </button>
        </li>)}
      </ul>
    </nav>
    <label className={css.categoryPicker}>
      <span>{t('categoryLabel')}</span>
      <select value={JSON.stringify(selectedId)} onChange={event => { onSelect(JSON.parse(event.currentTarget.value) as string | null) }}>
        <option value="null">{t('categoryOption', { name: t('categoryAll'), count: total })}</option>
        {categories.map(category => <option key={category.id} value={JSON.stringify(category.id)}>
          {t('categoryOption', { name: resolveText(category.label), count: category.count })}
        </option>)}
      </select>
    </label>
  </div>
}
