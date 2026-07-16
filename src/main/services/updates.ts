import { net } from 'electron'
import type { UpdateCheckResult } from '../../shared/types'

const RELEASE_API_URL = 'https://api.github.com/repos/pinuocao-c/jingpan/releases/latest'
const RELEASE_PATH_PREFIX = '/pinuocao-c/jingpan/releases/tag/'
const DOWNLOAD_PATH_PREFIX = '/pinuocao-c/jingpan/releases/download/'
const MAX_RELEASE_BODY_LENGTH = 4_000
const MAX_INSTALLER_BYTES = 500 * 1024 ** 2

interface GitHubReleaseAsset {
  name?: unknown
  size?: unknown
  digest?: unknown
  browser_download_url?: unknown
  state?: unknown
}

interface GitHubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  html_url?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

export interface TrustedUpdate extends UpdateCheckResult {
  downloadUrl: string | null
  releaseUrl: string | null
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  return match.slice(1).filter((part): part is string => part !== undefined).map(Number)
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (!leftParts || !rightParts) throw new Error('无法识别版本号')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function trustedGitHubUrl(value: unknown, expectedPath: string): string | null {
  if (typeof value !== 'string' || value.length > 2_081) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.username
      || url.password
      || url.port
      || url.pathname !== expectedPath
    ) return null
    return url.toString()
  } catch {
    return null
  }
}

function errorResult(currentVersion: string, message: string): TrustedUpdate {
  return {
    status: 'error',
    currentVersion,
    latestVersion: null,
    releaseName: null,
    releaseNotes: '',
    publishedAt: null,
    assetName: null,
    assetBytes: 0,
    assetDigest: null,
    downloadAvailable: false,
    checkedAt: new Date().toISOString(),
    message,
    downloadUrl: null,
    releaseUrl: null
  }
}

export function evaluateLatestRelease(currentVersion: string, payload: unknown): TrustedUpdate {
  if (!payload || typeof payload !== 'object') return errorResult(currentVersion, '更新服务器返回了无效数据')
  const release = payload as GitHubRelease
  if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string') {
    return errorResult(currentVersion, '没有找到可用的正式版本')
  }

  const latestParts = parseVersion(release.tag_name)
  if (!latestParts) return errorResult(currentVersion, '最新版本号格式无效')
  const latestVersion = latestParts.join('.')
  const releaseUrl = trustedGitHubUrl(release.html_url, `${RELEASE_PATH_PREFIX}v${latestVersion}`)
  if (!releaseUrl) return errorResult(currentVersion, '更新页面地址未通过安全校验')

  const common = {
    currentVersion,
    latestVersion,
    releaseName: typeof release.name === 'string' && release.name.trim()
      ? release.name.trim().slice(0, 120)
      : `净盘 v${latestVersion}`,
    releaseNotes: typeof release.body === 'string' ? release.body.slice(0, MAX_RELEASE_BODY_LENGTH) : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    checkedAt: new Date().toISOString(),
    releaseUrl
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return {
      ...common,
      status: 'current',
      assetName: null,
      assetBytes: 0,
      assetDigest: null,
      downloadAvailable: false,
      message: `当前已是最新版本 v${currentVersion}`,
      downloadUrl: null
    }
  }

  const expectedAssetName = `Jingpan-${latestVersion}-x64.exe`
  const assets = Array.isArray(release.assets) ? release.assets as GitHubReleaseAsset[] : []
  const asset = assets.find((item) => item.name === expectedAssetName && item.state === 'uploaded')
  const assetBytes = typeof asset?.size === 'number' && Number.isSafeInteger(asset.size)
    ? asset.size
    : 0
  const expectedDownloadPath = `${DOWNLOAD_PATH_PREFIX}v${latestVersion}/${expectedAssetName}`
  const downloadUrl = trustedGitHubUrl(asset?.browser_download_url, expectedDownloadPath)
  const validAsset = Boolean(
    asset
    && assetBytes > 0
    && assetBytes <= MAX_INSTALLER_BYTES
    && downloadUrl
  )
  const assetDigest = typeof asset?.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)
    ? asset.digest.toLowerCase()
    : null

  return {
    ...common,
    status: 'available',
    assetName: validAsset ? expectedAssetName : null,
    assetBytes: validAsset ? assetBytes : 0,
    assetDigest: validAsset ? assetDigest : null,
    downloadAvailable: validAsset,
    message: validAsset
      ? `发现新版本 v${latestVersion}`
      : `发现新版本 v${latestVersion}，但安装包尚未准备完成`,
    downloadUrl: validAsset ? downloadUrl : null
  }
}

export async function fetchLatestUpdate(currentVersion: string): Promise<TrustedUpdate> {
  try {
    const response = await net.fetch(RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Jingpan/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) {
      return errorResult(currentVersion, `更新服务器暂时不可用（HTTP ${response.status}）`)
    }
    return evaluateLatestRelease(currentVersion, await response.json())
  } catch (error) {
    return errorResult(
      currentVersion,
      `暂时无法检查更新：${error instanceof Error ? error.message : String(error)}`
    )
  }
}
