/**
 * Local Lab omp hook: ask before any file write or edit outside the session folder.
 *
 * omp's approval tiers treat every write/edit as the "write" tier wherever it
 * points, so "auto-accept edits" (omp --approval-mode write) would let a model
 * write anywhere on disk. Seen live: a local model, unsure where "the attached
 * image" lived, created ~/Library/Claude/Projects/… and wrote there. This hook
 * turns any write that resolves outside the folder (after symlinks and "..")
 * into an approval prompt, which reaches Local Lab as a normal approval card.
 * Local Lab loads it with --hook for every mode except Full auto.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

const WRITE_TOOLS = new Set(["write", "edit", "ast_edit"]);

/** Same path extraction omp's edit tool uses for its own approval prompt. */
function targetPath(input: Record<string, unknown>): string | undefined {
	const raw = typeof input.input === "string" ? input.input : undefined;
	if (raw) {
		const hashline = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(raw);
		if (hashline?.[1]) return hashline[1];
		const patch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(raw);
		if (patch?.[1]) return patch[1].trim();
	}
	for (const key of ["path", "file_path", "filePath", "file"]) {
		if (typeof input[key] === "string" && input[key]) return input[key] as string;
	}
	return undefined;
}

/** Resolve through symlinks, using the nearest existing ancestor for new files. */
function real(p: string): string {
	let cur = p;
	const tail: string[] = [];
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) return p;
		tail.unshift(cur.slice(parent.length + 1));
		cur = parent;
	}
	return [realpathSync(cur), ...tail].join(sep);
}

export default function (pi: any) {
	const root = real(process.cwd());
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;
		const target = targetPath(event.input ?? {});
		if (!target || /^[a-z]+:\/\//i.test(target)) return undefined; // internal URLs (memory://, …)
		const abs = real(isAbsolute(target) ? target : resolve(root, target));
		if (abs === root || abs.startsWith(root + sep)) return undefined;
		const ok = ctx?.hasUI
			? await ctx.ui.confirm("Write outside the session folder?", `${event.toolName}: ${abs}\nSession folder: ${root}`)
			: false;
		return ok ? undefined : { block: true, reason: `Writing outside ${root} was not approved.` };
	});
}
