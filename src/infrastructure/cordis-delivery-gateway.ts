/**
 * Cordis 投递网关（基础设施层实现）。
 *
 * 负责真正把消息交给运行时，按领域路由规则选择通道：
 * 同团队成员走 `agentTeams.sendMessage`，自己的子代理走 `subagents.sendMessage`，
 * 其余走会话 inbox（必要时冷唤醒 → steer → flush → 确认 inbox 接收）。
 *
 * 官方通道成功即视为送达（inbox acceptance，不等待模型处理）。在线目标在官方
 * 通道拒绝时可以安全回落到 inbox；离线目标的官方通道本身就是负责冷恢复的那条
 * 路径，绕过它会把会话唤醒成缺少父级/团队语义的错误形态，因此直接失败并把消息
 * 留在发送方账本等待重试。
 *
 * 冷唤醒必须带完整模型路由：历史 `request/header` 优先，其次是部署默认模型。
 * 缺少路由时拒绝唤醒——被唤醒 Agent 的首轮会在 prompt 组装阶段失败并吞掉消息。
 *
 * @module dsh-plugin-session-messaging/infrastructure/cordis-delivery-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle, AgentOptions, ContentBlock, UserMessage } from '../types.ts'
import type {
  Caller,
  DeliveryGateway,
  DeliveryOutcome,
  DeliverySenderFacts,
} from '../application/ports.ts'
import type { SessionTarget } from '../domain/target.ts'
import { isOwnSubagent, planDelivery } from '../domain/routing.ts'
import { messageAccepted, noticeMessage } from '../domain/message.ts'
import { foldAgentOptions, readPersistedSession } from './persisted-session.ts'

/**
 * 冷唤醒后等待首个失败信号的窗口（毫秒）。
 *
 * 它只用于发现 prompt 组装级别、归档门禁级别的快速失败；「是否送达」不由它决定，
 * 而是回到会话事件里的实际证据（见 `deliver`）。
 */
const WAKE_SETTLE_MS = 1_200

/** `ctx.subagents.sendMessage` 的最小结构。 */
interface SubagentChannel {
  sendMessage(
    sender: Agent,
    targetId: string,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ): Promise<string>
}

/** `ctx.agentTeams.sendMessage` 的最小结构。 */
interface TeamChannel {
  sendMessage(
    sender: Agent,
    request: { target: string; content: ContentBlock[]; signal: AbortSignal },
  ): Promise<{ messageId: string }>
}

/** 冷唤醒 Agent 的首轮错误探针。 */
interface WakeFailure {
  /** 首个 `agent/error`、归档门禁的 blocked 收口，或超时（undefined）。 */
  readonly promise: Promise<Error | undefined>
  /**
   * 注册在恢复上下文上的监听清理函数。
   *
   * 必须在判定结束后调用：被恢复的 Agent 可能长期在线，闭包不释放会一直持有
   * 探针与目标会话引用。
   */
  readonly disposers: (() => void)[]
  error?: Error
  resolve(error: Error): void
}

/** 一次冷唤醒的结果。 */
interface WakeResult {
  readonly agent: Agent
  /** 本插件拥有的恢复句柄；在线目标没有。 */
  readonly handle?: AgentHandle
  /** 只有冷唤醒才有错误探针。 */
  readonly failure?: WakeFailure
  /** 是否由本次调用从持久化会话恢复。 */
  readonly cold: boolean
}

/** 投递网关实现。 */
export class CordisDeliveryGateway implements DeliveryGateway {
  private readonly controller = new AbortController()
  private readonly handles = new Set<AgentHandle>()
  private readonly resumes = new Map<string, { job: Promise<WakeResult>; settled: boolean }>()

  /**
   * @param ctx - Cordis 上下文（agents / sessions / 通道服务）。
   * @param log - 可选日志出口。
   */
  constructor(
    private readonly ctx: Context,
    private readonly log: (message: string) => void,
  ) {}

  /** @inheritdoc */
  async deliver(
    target: SessionTarget,
    message: UserMessage,
    sender: DeliverySenderFacts,
    signal: AbortSignal,
  ): Promise<DeliveryOutcome> {
    // 归档会话不可唤醒：DSH 的归档门禁用 `turn/end blocked` 收口，没有 agent/error，
    // 插件无法把一次“唤醒即丢”的投递判成失败，所以必须提前拒绝。
    if (target.archived === true) {
      throw new Error('目标会话已归档：DSH 归档门禁会拒绝它的模型 step，投递已取消；请先取消归档再发送')
    }
    const senderAgent = this.ctx.agents.get(sender.senderId)
    const caller: Caller | undefined = senderAgent === undefined
      ? undefined
      : { agent: senderAgent, identity: { id: sender.senderId } }
    const subagents = this.ctx.get('subagents') as SubagentChannel | undefined
    const teams = this.ctx.get('agentTeams') as TeamChannel | undefined
    const decision = planDelivery({
      target,
      senderId: sender.senderId,
      isOwnSubagent: isOwnSubagent(target, sender.senderId),
      ...sender.teamMemberName === undefined ? {} : { teamMemberName: sender.teamMemberName },
      hasSubagentChannel: subagents !== undefined && caller !== undefined,
      hasTeamChannel: teams !== undefined && caller !== undefined && sender.teamMemberName !== undefined,
    })

    if (decision.route === 'subagent' && subagents !== undefined && caller !== undefined) {
      try {
        const channelId = await subagents.sendMessage(caller.agent, target.id, message.content, { signal })
        return {
          accepted: true,
          route: 'subagent',
          detail: `已通过 subagent 通道送达（${channelId}）`,
        }
      } catch (error) {
        this.log(`[session-messaging] subagent 通道拒绝 ${target.id}: ${messageOf(error)}`)
        // 已结束的子代理只能靠 subagent 通道冷恢复；回落到 inbox 会把它当根会话唤醒。
        if (target.status === 'offline') {
          throw new Error(`subagent 通道无法冷恢复 ${target.id}：${messageOf(error)}`)
        }
      }
    }

    if (decision.route === 'team' && teams !== undefined && caller !== undefined
      && decision.memberName !== undefined) {
      try {
        const result = await teams.sendMessage(caller.agent, {
          target: decision.memberName,
          content: message.content,
          signal,
        })
        return {
          accepted: true,
          route: 'team',
          detail: `已通过团队邮箱送达（${result.messageId}）`,
        }
      } catch (error) {
        this.log(`[session-messaging] 团队通道拒绝 ${target.id}: ${messageOf(error)}`)
        // inactive 队友只能靠 team mailbox 冷恢复（它会以 Lead 的授权恢复子会话）。
        if (target.status === 'offline') {
          throw new Error(`团队通道无法冷恢复 ${target.id}：${messageOf(error)}`)
        }
      }
    }

    const messageId = String(message.source['messageId'])
    const known = this.ctx.agents.get(target.id)
    const woke = known === undefined ? await this.wake(target.id, signal) : undefined
    const agent = known ?? woke?.agent
    if (agent === undefined) throw new Error(`无法获得目标会话 ${target.id} 的在线 Agent`)
    // 送达的唯一标准是「消息真的进入了目标会话」：历史里有 user/message，或仍挂在
    // inbox splice 投影里。1.2s 窗口只用来发现首轮快速失败，不能当送达的证据：
    // 晚到的 blocked 收口会让「唤醒即丢」被误判成 accepted。
    const evidence = (): boolean => messageAccepted(agent.session.ownEvents(), messageId)
    try {
      agent.steer(message)
      await this.flush(agent)

      // 在线目标：steer 不抛错就说明消息已进入它的 inbox（内存里），这与
      // 「第一条事件已经落盘」无关，不能因为 flush 时序把它改成 queued。
      if (known !== undefined) {
        return {
          accepted: true,
          route: 'steer',
          detail: '消息已进入目标会话的 inbox',
        }
      }

      if (woke?.failure !== undefined) {
        const failure = await this.awaitFailure(woke.failure)
        // 只有「首轮报错且消息没有进入历史」才是真失败；已进入历史就按送达处理。
        if (failure !== undefined && !evidence()) {
          await this.abandon(target.id, woke.handle)
          throw new Error(`冷唤醒后首轮失败（${failure.message}）；消息已留在发送方账本等待重试`)
        }
      }

      if (!evidence()) {
        // 冷唤醒后既没有报错也没有落账证据：不写 delivered 终态，让恢复流程在
        // 下次启动时重放；恢复句柄一并放弃，允许下次重新唤醒。
        await this.abandon(target.id, woke?.handle)
        return {
          accepted: false,
          route: 'steer',
          detail: '消息未能确认进入目标会话，已保留在发送方账本等待重试',
        }
      }
      return {
        accepted: true,
        route: 'steer',
        detail: '已冷唤醒目标会话，消息已进入其会话 inbox',
      }
    } finally {
      // 判定结束就摘掉监听：长驻 Agent 上它们没有任何后续用途。
      for (const off of woke?.failure?.disposers ?? []) {
        if (typeof off === 'function') off()
      }
    }
  }

  /** @inheritdoc */
  notify(agentId: string, text: string, topic: string): void {
    const agent = this.ctx.agents.get(agentId)
    if (agent === undefined) return
    try {
      agent.steer(noticeMessage(randomUUID(), text, topic))
    } catch (error) {
      this.log(`[session-messaging] 通知 ${agentId} 失败: ${String(error)}`)
    }
  }

  /** 释放本插件拥有的恢复句柄并停止接收新工作。 */
  dispose(): void {
    this.controller.abort()
    for (const handle of this.handles) {
      void Promise.resolve(handle.dispose()).catch(() => {})
    }
    this.handles.clear()
    this.resumes.clear()
  }

  /** 会话日志刷新；splice 已经在事件视图里，刷新失败不影响判定。 */
  private async flush(agent: Agent): Promise<void> {
    try {
      await this.ctx.sessions.flush(agent.session)
    } catch (error) {
      this.log(`[session-messaging] 刷新 ${agent.id} 的会话日志失败: ${String(error)}`)
    }
  }

  /** 冷唤醒一个持久化会话，同一目标并发只恢复一次。 */
  private wake(targetId: string, signal: AbortSignal): Promise<WakeResult> {
    const existing = this.resumes.get(targetId)
    if (existing !== undefined) {
      if (!existing.settled) return existing.job
      // 之前由本插件恢复的会话一旦结束就不再可用，后续发送要能再次唤醒。
      if (this.ctx.agents.get(targetId) !== undefined) return existing.job
      this.resumes.delete(targetId)
    }
    const entry: { job: Promise<WakeResult>; settled: boolean } = {
      job: this.startWake(targetId, signal),
      settled: false,
    }
    this.resumes.set(targetId, entry)
    entry.job.then(
      () => { entry.settled = true },
      () => {
        if (this.resumes.get(targetId) === entry) this.resumes.delete(targetId)
      },
    )
    return entry.job
  }

  /**
   * 启动一次恢复：带完整模型路由，挂载历史预置（失败再降级为不挂预置），
   * 并在恢复到 Agent 后校验模型路由确实落在 options 上。
   */
  private async startWake(targetId: string, signal: AbortSignal): Promise<WakeResult> {
    const live = this.ctx.agents.get(targetId)
    if (live !== undefined) return { agent: live, cold: false }

    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('会话持久化未配置，无法唤醒目标会话')
    }
    const view = await readPersistedSession(persistence, targetId, signal)
    const ownEvents = view.events.slice(view.inheritedEventCount)
    const agentOptions = this.wakeOptions(ownEvents)

    const presets = this.ctx.get('agentPresets')
    const presetId = view.header.agentPreset
    const failure = this.failureProbe()
    const watch = (agentCtx: Context): void => {
      // 宿主（或测试替身）可能不返回释放函数，只有函数才登记。
      const track = (off: () => unknown): void => {
        if (typeof off === 'function') failure.disposers.push(off)
      }
      track(agentCtx.on('agent/error', ({ error }) => {
        if (failure.error === undefined) failure.error = error
        failure.resolve(error)
      }))
      // 归档门禁不会发 agent/error：被拒的回合只在会话日志里以 turn/end blocked 收口。
      // 监听会话事件才能识别“唤醒成功但首轮被门禁拦下”的静默丢消息。
      track(agentCtx.on('session/event', (session, event) => {
        if (session.id !== targetId) return
        const reason = (event.data as { readonly reason?: { readonly kind?: string } } | undefined)?.reason
        if (event.type !== 'turn/end' || reason?.kind !== 'blocked') return
        const blocked = new Error('目标会话被归档门禁拒绝（turn/end blocked），消息未进入历史')
        if (failure.error === undefined) failure.error = blocked
        failure.resolve(blocked)
      }))
    }
    const plainSetup = (agentCtx: Context): void => { watch(agentCtx) }
    const presetSetup = presets !== undefined && presetId !== undefined
      ? async (agentCtx: Context): Promise<void> => {
        watch(agentCtx)
        await presets.mount(agentCtx, presetId)
      }
      : undefined

    const attempts: (() => Promise<AgentHandle>)[] = []
    if (presetSetup !== undefined) {
      attempts.push(() => this.ctx.agents.resume({
        resumeSessionId: targetId,
        agentOptions,
        setup: presetSetup,
        signal,
      }))
    }
    attempts.push(() => this.ctx.agents.resume({
      resumeSessionId: targetId,
      agentOptions,
      setup: plainSetup,
      signal,
    }))

    let lastError: unknown
    for (const [index, attempt] of attempts.entries()) {
      try {
        const handle = await attempt()
        const route = handle.agent.options
        if (route?.provider === undefined || route.provider === ''
          || route.model === undefined || route.model === '') {
          await this.disposeHandle(handle)
          throw new Error('恢复出的 Agent 没有 provider/model 路由，拒绝用会在首轮吞消息的实例投递')
        }
        this.handles.add(handle)
        return { agent: handle.agent, handle, failure, cold: true }
      } catch (error) {
        lastError = error
        this.log(`[session-messaging] 唤醒 ${targetId} 第 ${index + 1}/${attempts.length} 次尝试失败: ${messageOf(error)}`)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** 计算冷唤醒使用的模型路由：历史优先，部署默认兜底；都没有时拒绝唤醒。 */
  private wakeOptions(events: Parameters<typeof foldAgentOptions>[0]): AgentOptions {
    const folded = foldAgentOptions(events)
    if (typeof folded['provider'] === 'string' && folded['provider'] !== ''
      && typeof folded['model'] === 'string' && folded['model'] !== '') {
      return folded
    }
    const fallback = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback !== undefined && fallback.provider !== '' && fallback.model !== '') {
      return {
        provider: fallback.provider,
        model: fallback.model,
        ...fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort },
      }
    }
    throw new Error(
      '目标会话没有可用的模型路由（历史没有 request/header，部署也没有默认模型）；'
      + '拒绝用会在首轮吞消息的 Agent 唤醒，消息已保留在发送方账本',
    )
  }

  /** 创建一个只会在首次错误时 resolve 的探针。 */
  private failureProbe(): WakeFailure {
    let resolve!: (error: Error) => void
    const promise = new Promise<Error | undefined>((done) => { resolve = done })
    return { promise, disposers: [], resolve }
  }

  /** 等待首轮错误，但最多等 `WAKE_SETTLE_MS`。 */
  private async awaitFailure(failure: WakeFailure): Promise<Error | undefined> {
    return await Promise.race([
      failure.promise,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), WAKE_SETTLE_MS)
        timer.unref?.()
      }),
    ])
  }

  /** 放弃一个刚恢复但首轮失败的 Agent，并清掉恢复缓存，允许下次重试。 */
  private async abandon(targetId: string, handle: AgentHandle | undefined): Promise<void> {
    const entry = this.resumes.get(targetId)
    if (entry !== undefined) this.resumes.delete(targetId)
    if (handle === undefined) return
    this.handles.delete(handle)
    await this.disposeHandle(handle)
  }

  /** 释放恢复句柄；失败只记录日志。 */
  private async disposeHandle(handle: AgentHandle): Promise<void> {
    try {
      await handle.dispose()
    } catch (error) {
      this.log(`[session-messaging] 释放恢复句柄失败: ${messageOf(error)}`)
    }
  }
}

/** 把未知错误转成消息文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
