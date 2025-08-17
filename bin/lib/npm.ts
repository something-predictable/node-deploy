import { exec } from 'node:child_process'

export async function install(dir: string) {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        const proc = exec(
            'npm install --omit=dev',
            {
                cwd: dir,
            },
            err => {
                if (err) {
                    reject(err)
                }
            },
        )
        const onError = (error: Error) => {
            reject(error)
            proc.removeListener('error', onError)
            proc.removeListener('exit', onExit)
        }
        const onExit = (code: number | null) => {
            resolve(code)
            proc.removeListener('error', onError)
            proc.removeListener('exit', onExit)
        }
        proc.stderr?.pipe(process.stderr)
        proc.addListener('error', onError)
        proc.addListener('exit', onExit)
    })
    if (exitCode !== 0) {
        throw new Error(`Non-zero exit code from npm install in ${dir}`)
    }
}
