/** Shared archive input constraints; no OS, browser or Host APIs. */
export const PLUGIN_ARCHIVE_ACCEPT = '.zip,.tar,.tgz,.tar.gz'
export const MAX_PLUGIN_ARCHIVE_BYTES = 30 * 1024 * 1024

export function pluginArchiveSuffix(name: string): string | undefined {
  const match = /\.(tar\.gz|zip|tgz|tar)$/i.exec(name)
  return match === null ? undefined : `.${match[1].toLowerCase()}`
}
