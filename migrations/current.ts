/** The baseline the runtime opens. `index.ts` holds the full history; this
 * file has no imports so the runtime can name its schema without loading
 * every cutover. */
export const current = "0002-typed"
export const currentDirectory = `migrations/${current}`
