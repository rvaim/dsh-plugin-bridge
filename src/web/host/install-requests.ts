import type { InstallPreparation, InstallResult } from '../../manager/manager.js'
import type { CompatService } from '../../service.js'

type InstallTarget = Pick<CompatService,
  'prepareInstall' | 'completeInstallPreparation' | 'releaseInstallPreparation'>

type RequestState =
  | { kind: 'pending' | 'install-failed' | 'release-failed' }
  | { kind: 'installing'; operation: Promise<InstallResult> }
  | { kind: 'releasing'; operation: Promise<void> }
  | { kind: 'installed' }
  | { kind: 'released' }

interface InstallRequest {
  preparationId: string
  state: RequestState
  cancelRequested: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** Web 添加流程的会话状态；Source 的所有权和回收判断完全交给 manager。 */
export class InstallRequests {
  private readonly requests = new Map<string, InstallRequest>()
  private readonly preparations = new Set<Promise<InstallPreparation>>()
  private closed = false
  private disposing?: Promise<void>

  constructor(
    private readonly compat: InstallTarget,
    private readonly requestTtlMs: number,
  ) {}

  prepare(source: string): Promise<InstallPreparation> {
    if (this.closed) return Promise.reject(new Error('添加服务已关闭'))
    const operation = Promise.resolve().then(async () => {
      const preparation = await this.compat.prepareInstall(source)
      const request: InstallRequest = {
        preparationId: preparation.preparationId,
        state: { kind: 'pending' },
        cancelRequested: false,
      }
      this.requests.set(request.preparationId, request)
      // dispose 会等准备操作结束后释放它，不把关闭期间到达的会话交给页面。
      if (this.closed) throw new Error('添加服务已关闭')
      this.armTimer(request)
      return preparation
    })
    this.preparations.add(operation)
    void operation.then(
      () => this.preparations.delete(operation),
      () => this.preparations.delete(operation),
    )
    return operation
  }

  complete(requestId: string, plugins: string[]): Promise<InstallResult> {
    if (this.closed) return Promise.reject(new Error('添加服务已关闭'))
    const request = this.requests.get(requestId)
    if (request === undefined) return Promise.reject(new Error('该添加请求已过期，请重新拉取来源'))
    if (request.cancelRequested) {
      return Promise.reject(new Error('该添加请求正在取消，请重试取消或重新拉取来源'))
    }
    if (request.state.kind === 'installing') return request.state.operation
    if (request.state.kind === 'releasing' || request.state.kind === 'release-failed') {
      return Promise.reject(new Error('该添加请求正在取消，请重试取消或重新拉取来源'))
    }
    if (request.state.kind === 'installed' || request.state.kind === 'released') {
      return Promise.reject(new Error('该添加请求已结束，请重新拉取来源'))
    }

    this.clearTimer(request)
    const selection = [...plugins]
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await this.compat.completeInstallPreparation(request.preparationId, selection)
        request.state = { kind: 'installed' }
        this.requests.delete(requestId)
        return result
      } catch (error) {
        // manager 安装失败不消耗准备会话，页面仍可重试或取消。
        request.state = { kind: 'install-failed' }
        if (!this.closed && !request.cancelRequested) this.armTimer(request)
        throw error
      }
    })
    request.state = { kind: 'installing', operation }
    return operation
  }

  cancel(requestId: string): Promise<void> {
    const request = this.requests.get(requestId)
    return request === undefined ? Promise.resolve() : this.release(request)
  }

  dispose(): Promise<void> {
    this.closed = true
    for (const request of this.requests.values()) this.clearTimer(request)
    if (this.disposing !== undefined) return this.disposing
    const operation = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.preparations])
      const results = await Promise.allSettled([...this.requests.values()].map(request => this.release(request)))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) {
        throw new AggregateError(failures, '未能释放全部安装准备会话；可再次关闭以重试')
      }
    })
    this.disposing = operation
    // 释放失败的记录留在 requests 中，下次 dispose 或 cancel 可以重试。
    void operation.then(
      () => { this.disposing = undefined },
      () => { this.disposing = undefined },
    )
    return operation
  }

  private release(request: InstallRequest): Promise<void> {
    request.cancelRequested = true
    this.clearTimer(request)
    if (request.state.kind === 'installing') {
      // 安装成功已消费会话；安装失败后才执行释放，绝不抢走进行中的快照。
      return request.state.operation.then(() => {}, () => this.release(request))
    }
    if (request.state.kind === 'releasing') return request.state.operation
    if (request.state.kind === 'installed' || request.state.kind === 'released') return Promise.resolve()
    const operation = Promise.resolve().then(async () => {
      try {
        await this.compat.releaseInstallPreparation(request.preparationId)
        request.state = { kind: 'released' }
        this.requests.delete(request.preparationId)
      } catch (error) {
        request.state = { kind: 'release-failed' }
        throw error
      }
    })
    request.state = { kind: 'releasing', operation }
    return operation
  }

  private armTimer(request: InstallRequest): void {
    this.clearTimer(request)
    request.timer = setTimeout(() => {
      // TTL 的失败状态保留供显式取消或 dispose 重试，并由 dispose 报告持续失败。
      void this.cancel(request.preparationId).catch(() => {})
    }, this.requestTtlMs)
    request.timer.unref?.()
  }

  private clearTimer(request: InstallRequest): void {
    if (request.timer === undefined) return
    clearTimeout(request.timer)
    request.timer = undefined
  }
}
