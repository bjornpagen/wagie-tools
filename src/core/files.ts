import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import { Refusal } from "./values.ts"

export const io = <A>(operation: string, work: () => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: (cause) =>
			new Refusal({
				code: "FileAccess",
				message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`
			})
	})

export const privateDirectory = (directory: string) =>
	io("create private directory", async () => {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 })
		await fs.chmod(directory, 0o700)
	})

/** Publish complete bytes once, then flush the directory before dispatch.
 * A hard link is an atomic, exclusive publication on the same filesystem;
 * another process can never observe a partly written retained command.
 */
export const retainOnce = (file: string, bytes: string | Uint8Array) =>
	io("retain command", async () => {
		const parent = path.dirname(file)
		const temporary = await fs.mkdtemp(path.join(parent, ".retaining-"))
		let published = false
		try {
			const candidate = path.join(temporary, "complete")
			await fs.writeFile(candidate, bytes, { flag: "wx", mode: 0o600, flush: true })
			try {
				await fs.link(candidate, file)
				published = true
			} catch (cause) {
				if (!(cause !== null && typeof cause === "object" && "code" in cause && cause.code === "EEXIST"))
					throw cause
			}
			// A concurrent loser also flushes the winner's publication before
			// resolving it; success never depends on the other process staying alive.
			const directory = await fs.open(parent, "r")
			try {
				await directory.sync()
			} finally {
				await directory.close()
			}
			return published
		} finally {
			await fs.rm(temporary, { recursive: true })
		}
	})

export const retain = (file: string, bytes: string | Uint8Array) =>
	retainOnce(file, bytes).pipe(
		Effect.flatMap((created) =>
			created
				? Effect.void
				: Effect.fail(
						new Refusal({ code: "RetainedFileExists", message: `A retained file already exists: ${file}` })
					)
		)
	)

export const readText = (file: string) => io("read file", () => fs.readFile(file, "utf8"))
export const readBytes = (file: string) => io("read file", () => fs.readFile(file))
export const exists = (file: string) =>
	io("inspect file", async () => {
		try {
			await fs.stat(file)
			return true
		} catch (cause) {
			if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
				return false
			throw cause
		}
	})
