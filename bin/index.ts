#!/usr/bin/env node

import { reflect } from '@riddance/host/reflect'
import { Resolver } from './lib/aws/resolve.js'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue } from './lib/glue.js'
import { stage } from './lib/stage.js'

const [, , pathOrEnvArg, envArg, glueFile] = process.argv
if (!pathOrEnvArg) {
    throw new Error('Please specify target environment name')
}
const path = envArg ? pathOrEnvArg : process.cwd()
const envName = envArg ?? pathOrEnvArg

try {
    const resolver = new Resolver(envName)
    const [{ service, implementations, corsSites, env, ...provider }, reflection] =
        await Promise.all([getGlue(path, envName, resolver, glueFile), reflect(path)])
    const [currentState, code] = await Promise.all([
        getCurrentState(envName, service),
        stage(
            path,
            reflection.revision,
            implementations,
            service,
            Object.fromEntries(reflection.http.map(fn => [fn.name, 'http'] as const)),
        ),
    ])

    const host = await sync(
        envName,
        service,
        currentState,
        reflection,
        corsSites,
        await env,
        Object.fromEntries(code.map(c => [c.fn, c.code])),
        provider,
    )

    console.log('done.')
    console.log(`hosting on ${host}`)
} catch (e) {
    const fileError = e as { code?: string; path?: string }
    if (fileError.code === 'ENOENT' && fileError.path?.endsWith('glue.json')) {
        console.error(
            "Glue not found. Try to see if there isn't a glue project you can clone next to this project.",
        )
        process.exit(1)
    }
    throw e
}
