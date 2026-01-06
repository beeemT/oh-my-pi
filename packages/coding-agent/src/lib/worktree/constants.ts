import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getWorktreeBase(): string {
	try {
		accessSync("/work", constants.W_OK);
		return "/work/.tree";
	} catch {
		return path.join(os.tmpdir(), ".tree");
	}
}

export const WORKTREE_BASE = getWorktreeBase();
