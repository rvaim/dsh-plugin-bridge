import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** The sidebar owns navigation and selection; this contribution supplies its glyph. */
export function PluginBridgePanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconLinkOutlineRegular size={size} />
}
