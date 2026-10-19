import { NextResponse } from "next/server"
import path from "path"
import { WorkflowById } from "@/services/prisma"
import { joinStoragePath, readStorageFile, StorageReadResult } from "@/services/storage"

export type WorkflowLogsResponse = {
	logFile: StorageReadResult | null
	outFile: StorageReadResult | null
	error?: string
}

async function readFirstAvailable(candidates: string[]): Promise<StorageReadResult | null> {
	const seen = new Set<string>()
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) {
			continue
		}
		seen.add(candidate)
		const result = await readStorageFile(candidate)
		if (result !== null) {
			return result
		}
	}
	return null
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
	const id = params.id

	try {
		const workflow = await WorkflowById(id)
		if (!workflow) {
			return NextResponse.json({ error: "Workflow not found" }, { status: 404 })
		}

		const logCandidates: string[] = []
		if (workflow.logFile) {
			logCandidates.push(workflow.logFile)
			if (workflow.workDir) {
				logCandidates.push(joinStoragePath(workflow.workDir, path.posix.basename(workflow.logFile)))
			}
		}
		if (workflow.workDir) {
			logCandidates.push(joinStoragePath(workflow.workDir, ".nextflow.log"))
		}
		if (workflow.launchDir) {
			logCandidates.push(joinStoragePath(workflow.launchDir, ".nextflow.log"))
		}

		const outCandidates: string[] = []
		if (workflow.outFile) {
			outCandidates.push(workflow.outFile)
			if (workflow.workDir) {
				outCandidates.push(joinStoragePath(workflow.workDir, path.posix.basename(workflow.outFile)))
			}
		}

		const [logFile, outFile] = await Promise.all([
			readFirstAvailable(logCandidates),
			readFirstAvailable(outCandidates),
		])

		return NextResponse.json<WorkflowLogsResponse>({
			logFile,
			outFile,
		})
	} catch (e: any) {
		console.error(e)
		return NextResponse.json(
			{
				logFile: null,
				outFile: null,
				error: e?.message ?? "Failed to read workflow logs",
			},
			{ status: 500 }
		)
	}
}
