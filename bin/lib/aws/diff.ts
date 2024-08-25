export function compare<T extends { name: string }, S extends { name: string }>(
    local: T[],
    current: S[],
) {
    const missing = local.filter(fn => !current.some(remote => remote.name === fn.name))
    const surplus = current.filter(remote => !local.some(fn => remote.name === fn.name))
    const existing = current.filter(remote => local.some(fn => remote.name === fn.name))
    return { missing, surplus, existing }
}
