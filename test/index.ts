import { fetchJson } from '@riddance/fetch'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
            {
                headers: {},
            },
            'Error fetching greeting',
        )
        assert.strictEqual(greeting.message, 'Hello from Riddance, World!')
    }).timeout(60_000)

    it('should deploy tick-tock', async () => {
        const log = new Log()
        await deployTestCase(log, 'tick-tock')
        assert.deepStrictEqual(log.issues, [])
    }).timeout(30_000)
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

class Log {
    issues: string[] = []

    trace() {
        //
    }
    warn(message: string) {
        this.issues.push(message)
    }
    error(message: string) {
        this.issues.push(message)
    }
}
