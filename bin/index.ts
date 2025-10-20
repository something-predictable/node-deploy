#!/usr/bin/env node

import { deploy } from '../index.js'
import { localAwsEnv } from '../lib/aws/lite.js'

const [, , pathOrEnvArg, envArg, glueFile] = process.argv
if (!pathOrEnvArg) {
    throw new Error('Please specify target environment name')
}
const path = envArg ? pathOrEnvArg : process.cwd()
const envName = envArg ?? pathOrEnvArg

try {
    const { logLink, host } = await deploy(
        {
            env: await localAwsEnv(undefined, envName),
            log: {
                trace: (message: string) => {
                    console.log(message)
                },
                warn: (message: string) => {
                    console.warn(message)
                },
                error: (message: string) => {
                    console.error(message)
                },
            },
        },
        envName,
        path,
        glueFile,
    )

    console.log('done.')

    if (host) {
        console.log()
        console.log(`hosting on ${host}`)
    }

    if (logLink) {
        console.log()
        console.log(`See logs here: ${logLink}`)
    }
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
