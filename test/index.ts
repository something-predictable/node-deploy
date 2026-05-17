import { fetchJson, fetchOK, thrownHasStatus } from '@riddance/fetch'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { deploy } from '../index.js'
import { localAwsEnv } from '../lib/aws/lite.js'
import { install } from '../lib/npm.js'
import { compile } from './lib/compile.js'

describe('deploy', () => {
    it('should deploy greeting', async () => {
        const log = new Log()
        await Promise.all([deployTestCase(log, 'greeting'), deployTestCase(log, 'subber')])
        const frontDoorHost = await deployTestCase(log, 'front-door')
        assert.deepStrictEqual(log.issues, [])
        assert.ok(frontDoorHost)

        const greeting = await fetchJson<{ message: string }>(
            frontDoorHost,
            { headers },
            'Error fetching greeting',
        )
        assert.strictEqual(greeting.message, 'Hello from Riddance, World!')
    }).timeout(60_000)

    it('should deploy tick-tock', async () => {
        const log = new Log()
        await deployTestCase(log, 'tick-tock')
        assert.deepStrictEqual(log.issues, [])
    }).timeout(30_000)

    it('should deploy big twice', async () => {
        const log = new Log()
        await deployTestCase(log, 'big')
        const host = await deployTestCase(log, 'big')
        assert.deepStrictEqual(log.issues, [])
        assert.ok(host)

        const result = await Promise.allSettled(
            Array.from({ length: 32 }, (_, ix) =>
                retry(() => fetchOK(`${host}${ix + 1}`, { headers }, `big #${ix + 1} failed`)),
            ),
        )
        assert.deepStrictEqual(
            result
                .filter(r => r.status === 'rejected')
                .map(
                    r =>
                        `${r.reason.message} (GET ${r.reason.response?.url}, status ${r.reason.response?.status})`,
                ),
            [],
            'Error fetching',
        )
    }).timeout(60_000)
})

async function deployTestCase(log: Log, name: string) {
    const path = join(process.cwd(), 'test/data/' + name)
    await install(path)
    compile(path)
    const stagePath = join(tmpdir(), 'riddance', 'deploy-test-stage', name)
    const { host } = await deploy(
        {
            log,
            env: await localAwsEnv(undefined, 'deploy-test'),
        },
        'deploy-test',
        path,
        undefined,
        stagePath,
    )
    return host
}

async function retry(fn: () => Promise<void>) {
    for (let i = 0; ; ++i) {
        try {
            await fn()
            return
        } catch (e) {
            if (thrownHasStatus(e, 503) && i < 5) {
                await setTimeout(1000)
                continue
            }
            throw e
        }
    }
}

const headers = {
    'user-agent': 'Riddance/1 (Deploy test)',
}

class Log {
    issues: string[] = []

    trace() {
        //
    }
    warn(message: string) {
        if (message.startsWith('CIRCULAR_DEPENDENCY') || message.includes(' -> ')) {
            return
        }
        this.issues.push(message)
    }
    error(message: string) {
        this.issues.push(message)
    }
}
