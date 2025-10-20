import ts from 'typescript'

export function compile(path: string) {
    const configFile = ts.readConfigFile('tsconfig.json', p => ts.sys.readFile(p))
    if (configFile.error) {
        throw new Error(
            `tsconfig file error: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, ';')}`,
        )
    }

    const tsconfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path)
    if (tsconfig.errors.length !== 0) {
        throw new Error(
            `tsconfig error: ${ts.flattenDiagnosticMessageText(tsconfig.errors.at(0)?.messageText, ';')}`,
        )
    }

    const program = ts.createProgram(tsconfig.fileNames, {
        ...tsconfig.options,
        listEmittedFiles: true,
        outDir: path,
        rootDir: path,
        typeRoots: ['node_modules/@types'],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    const error = diagnostics.find(d => d.category === ts.DiagnosticCategory.Error)
    if (error) {
        throw new Error(
            `TypeScript error: ${ts.flattenDiagnosticMessageText(error.messageText, ';')}`,
        )
    }
    program.emit()
}
