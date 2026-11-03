/**
 * 包级端到端：假 DSH 上下文 + 构建产物 `lib/index.js` + 真 socket/命名管道，
 * 验证工具与本地总线都能把消息投递进会话 inbox。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs, spliced } from './support/common.ts'
import { busRequest, waitForBus } from './support/e2e-bus.ts'
import { boot, makeE2eAgent } from './support/e2e-fixtures.ts'

afterEach(cleanupTempDirs)

describe('built package end to end', () => {
  it('delivers tool and bus messages into a live session inbox', async () => {
    const sender = makeE2eAgent({ id: 'sender', cwd: '/repo' })
    const target = makeE2eAgent({ id: 'target', cwd: '/repo' })
    const harness = boot({ agents: [sender, target], titles: new Map([['target', 'docs-bot']]) })
    try {
      const list = harness.tools.get('list_session_agents')
      const send = harness.tools.get('send_session_message')
      expect(list).toBeDefined()
      expect(send).toBeDefined()

      const listed = await list!.execute({}, harness.exec(sender)) as {
        agents: { name: string; id: string; state: string }[]
      }
      // 期望值写死字面量：`short_id` 是 shortIdOf 对 id 前 8 字符的投影，
      // 用 map 现算会在实现把 id 改坏时一起「自适应」，断言就失去意义。
      expect(listed.agents).toEqual([
        { name: 'docs-bot', id: 'target', short_id: 'target', cwd: '/repo', workspace: 'same', state: 'idle', kind: 'peer', sendable: true },
      ])

      const sent = await send!.execute({ to: 'docs-bot', message: 'ping', summary: 'e2e' }, harness.exec(sender)) as {
        status: string
        message_id: string
      }
      expect(sent.status).toBe('accepted')
      const delivered = spliced(target)
      expect(delivered).toHaveLength(1)
      const message = (delivered[0]!.data as { inserted: { source: { kind: string; messageId: string } }[] }).inserted[0]
      expect(message?.source.messageId).toBe(sent.message_id)
      expect(message?.source.kind).toBe('session-message')

      // 去重键包含摘要：同正文、同摘要才判 duplicate（摘要不同是另一条消息）。
      const duplicate = await send!.execute(
        { to: 'docs-bot', message: 'ping', summary: 'e2e' },
        harness.exec(sender),
      ) as {
        status: string
      }
      expect(duplicate.status).toBe('duplicate')

      // shell 传输：同一个会话用自己的 token，以 bash 的身份发起请求。
      // shellEnv 只在总线真正 listening 之后才注册（异步），这里等它出现。
      for (let attempt = 0; attempt < 200 && harness.shellContributors.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      const contributor = harness.shellContributors[0]!
      const env = contributor.resolve(harness.exec(sender))
      const endpoint = env['DSH_SESSION_MESSAGING_SOCKET']
      const token = env['DSH_SESSION_MESSAGING_TOKEN']
      expect(typeof endpoint).toBe('string')
      expect(typeof token).toBe('string')
      await waitForBus(endpoint!)

      const busList = await busRequest(endpoint!, token!, { op: 'list' })
      expect(busList.ok).toBe(true)
      expect((busList.result as { agents: { id: string }[] }).agents.map(row => row.id)).toEqual(['target'])

      const busSend = await busRequest(endpoint!, token!, { op: 'send', to: 'target', message: 'from the shell' })
      expect(busSend.ok).toBe(true)
      expect((busSend.result as { status: string }).status).toBe('accepted')
      expect(spliced(target)).toHaveLength(2)

      const forged = await busRequest(endpoint!, 'not-a-token', { op: 'list' })
      expect(forged.ok).toBe(false)
      expect(forged.error?.code).toBe('unauthenticated')
    } finally {
      await harness.dispose()
    }
  })
})
