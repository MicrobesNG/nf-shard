import { NextResponse } from "next/server"
import { TaskByWorkflowAndTaskId } from "@/services/prisma"
import { joinStoragePath, readStorageFile, StorageReadResult } from "@/services/storage"

export type TaskLogsResponse = {
	workdir?: string
	commandLog: StorageReadResult | null
	commandOut: StorageReadResult | null
	commandErr: StorageReadResult | null
	error?: string
}

export async function GET(request: Request, { params }: { params: { id: string; taskId: string } }) {
	const workflowId = params.id
	const taskId = Number(params.taskId)

	if (Number.isNaN(taskId)) {
		return NextResponse.json({ error: "Invalid taskId" }, { status: 400 })
	}

	try {
		const task = await TaskByWorkflowAndTaskId(workflowId, taskId)
		if (!task) {
			return NextResponse.json({ error: "Task not found" }, { status: 404 })
		}

		const workdir = task.data?.workdir
		if (!workdir) {
			return NextResponse.json<TaskLogsResponse>({
				workdir: undefined,
				commandLog: null,
				commandOut: null,
				commandErr: null,
			})
		}

		const [commandLog, commandOut, commandErr] = await Promise.all([
			readStorageFile(joinStoragePath(workdir, ".command.log")),
			readStorageFile(joinStoragePath(workdir, ".command.out")),
			readStorageFile(joinStoragePath(workdir, ".command.err")),
		])

		return NextResponse.json<TaskLogsResponse>({
			workdir,
			commandLog,
			commandOut,
			commandErr,
		})
	} catch (e: any) {
		console.error(e)
		return NextResponse.json(
			{
				commandLog: null,
				commandOut: null,
				commandErr: null,
				error: e?.message ?? "Failed to read task logs",
			},
			{ status: 500 }
		)
	}
}
