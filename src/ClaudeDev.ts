import { Anthropic } from "@anthropic-ai/sdk"
import defaultShell from "default-shell"
import * as diff from "diff"
import { execa, ExecaError, ResultPromise } from "execa"
import fs from "fs/promises"
import os from "os"
import osName from "os-name"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { serializeError } from "serialize-error"
import treeKill from "tree-kill"
import * as vscode from "vscode"
import { ApiHandler, buildApiHandler } from "./api"
import { listFiles, parseSourceCodeForDefinitionsTopLevel } from "./parse-source-code"
import { ClaudeDevProvider } from "./providers/ClaudeDevProvider"
import { ApiConfiguration } from "./shared/api"
import { ClaudeRequestResult } from "./shared/ClaudeRequestResult"
import { DEFAULT_MAX_REQUESTS_PER_TASK } from "./shared/Constants"
import { ClaudeAsk, ClaudeMessage, ClaudeSay, ClaudeSayTool } from "./shared/ExtensionMessage"
import { Tool, ToolName } from "./shared/Tool"
import { ClaudeAskResponse } from "./shared/WebviewMessage"
import delay from "delay"
import { getApiMetrics } from "./shared/getApiMetrics"
import { HistoryItem } from "./shared/HistoryItem"
import { combineApiRequests } from "./shared/combineApiRequests"
import { combineCommandSequences } from "./shared/combineCommandSequences"
import { findLastIndex } from "./utils"
import { SYSTEM_PROMPT } from "./systemPrompt"
import { tools } from "./tools"

const cwd =
	vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop")

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<
	Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>

export class ClaudeDev {
	readonly taskId: string
	private api: ApiHandler
	private maxRequestsPerTask: number
	private customInstructions?: string
	private requestCount = 0
	apiConversationHistory: Anthropic.MessageParam[] = []
	claudeMessages: ClaudeMessage[] = []
	private askResponse?: ClaudeAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private lastMessageTs?: number
	private executeCommandRunningProcess?: ResultPromise
	private providerRef: WeakRef<ClaudeDevProvider>
	private abort: boolean = false

	constructor(
		provider: ClaudeDevProvider,
		apiConfiguration: ApiConfiguration,
		maxRequestsPerTask?: number,
		customInstructions?: string,
		task?: string,
		images?: string[],
		historyItem?: HistoryItem
	) {
		this.providerRef = new WeakRef(provider)
		this.api = buildApiHandler(apiConfiguration)
		this.maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK
		this.customInstructions = customInstructions

		if (historyItem) {
			this.taskId = historyItem.id
			this.resumeTaskFromHistory()
		} else if (task || images) {
			this.taskId = Date.now().toString()
			this.startTask(task, images)
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}
	}

	updateApi(apiConfiguration: ApiConfiguration) {
		this.api = buildApiHandler(apiConfiguration)
	}

	updateMaxRequestsPerTask(maxRequestsPerTask: number | undefined) {
		this.maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK
	}

	updateCustomInstructions(customInstructions: string | undefined) {
		this.customInstructions = customInstructions
	}

	async handleWebviewAskResponse(askResponse: ClaudeAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
	}

	private async ensureTaskDirectoryExists(): Promise<string> {
		const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const taskDir = path.join(globalStoragePath, "tasks", this.taskId)
		await fs.mkdir(taskDir, { recursive: true })
		return taskDir
	}

	private async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), "api_conversation_history.json")
		const fileExists = await fs
			.access(filePath)
			.then(() => true)
			.catch(() => false)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		this.apiConversationHistory.push(message)
		await this.saveApiConversationHistory()
	}

	private async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), "api_conversation_history.json")
			await fs.writeFile(filePath, JSON.stringify(this.apiConversationHistory))
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
		}
	}

	private async getSavedClaudeMessages(): Promise<ClaudeMessage[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
		const fileExists = await fs
			.access(filePath)
			.then(() => true)
			.catch(() => false)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	private async addToClaudeMessages(message: ClaudeMessage) {
		this.claudeMessages.push(message)
		await this.saveClaudeMessages()
	}

	private async overwriteClaudeMessages(newMessages: ClaudeMessage[]) {
		this.claudeMessages = newMessages
		await this.saveClaudeMessages()
	}

	private async saveClaudeMessages() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
			await fs.writeFile(filePath, JSON.stringify(this.claudeMessages))
			const apiMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(this.claudeMessages.slice(1))))
			const taskMessage = this.claudeMessages[0]
			await this.providerRef.deref()?.updateTaskHistory({
				id: this.taskId,
				ts: taskMessage.ts,
				task: taskMessage.text ?? "",
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
			})
		} catch (error) {
			console.error("Failed to save claude messages:", error)
		}
	}

	async ask(
		type: ClaudeAsk,
		question?: string
	): Promise<{ response: ClaudeAskResponse; text?: string; images?: string[] }> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		const askTs = Date.now()
		this.lastMessageTs = askTs
		await this.addToClaudeMessages({ ts: askTs, type: "ask", ask: type, text: question })
		await this.providerRef.deref()?.postStateToWebview()
		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
		if (this.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored")
		}
		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		return result
	}

	async say(type: ClaudeSay, text?: string, images?: string[]): Promise<undefined> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}
		const sayTs = Date.now()
		this.lastMessageTs = sayTs
		await this.addToClaudeMessages({ ts: sayTs, type: "say", say: type, text: text, images })
		await this.providerRef.deref()?.postStateToWebview()
	}

	private formatImagesIntoBlocks(images?: string[]): Anthropic.ImageBlockParam[] {
		return images
			? images.map((dataUrl) => {
					const [rest, base64] = dataUrl.split(",")
					const mimeType = rest.split(":")[1].split(";")[0]
					return {
						type: "image",
						source: { type: "base64", media_type: mimeType, data: base64 },
					} as Anthropic.ImageBlockParam
			  })
			: []
	}

	private formatIntoToolResponse(text: string, images?: string[]): ToolResponse {
		if (images && images.length > 0) {
			const textBlock: Anthropic.TextBlockParam = { type: "text", text }
			const imageBlocks: Anthropic.ImageBlockParam[] = this.formatImagesIntoBlocks(images)
			return [textBlock, ...imageBlocks]
		} else {
			return text
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		this.claudeMessages = []
		this.apiConversationHistory = []
		await this.providerRef.deref()?.postStateToWebview()

		let textBlock: Anthropic.TextBlockParam = {
			type: "text",
			text: `<task>\n${task}\n</task>\n\n${this.getPotentiallyRelevantDetails()}`,
		}
		let imageBlocks: Anthropic.ImageBlockParam[] = this.formatImagesIntoBlocks(images)
		await this.say("text", task, images)
		await this.initiateTaskLoop([textBlock, ...imageBlocks])
	}

	private async resumeTaskFromHistory() {
		const modifiedClaudeMessages = await this.getSavedClaudeMessages()

		const lastApiReqStartedIndex = modifiedClaudeMessages.reduce(
			(lastIndex, m, index) => (m.type === "say" && m.say === "api_req_started" ? index : lastIndex),
			-1
		)
		const lastApiReqFinishedIndex = modifiedClaudeMessages.reduce(
			(lastIndex, m, index) => (m.type === "say" && m.say === "api_req_finished" ? index : lastIndex),
			-1
		)
		if (lastApiReqStartedIndex > lastApiReqFinishedIndex && lastApiReqStartedIndex !== -1) {
			modifiedClaudeMessages.splice(lastApiReqStartedIndex, 1)
		}

		const lastRelevantMessageIndex = findLastIndex(
			modifiedClaudeMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
		)
		if (lastRelevantMessageIndex !== -1) {
			modifiedClaudeMessages.splice(lastRelevantMessageIndex + 1)
		}

		await this.overwriteClaudeMessages(modifiedClaudeMessages)
		this.claudeMessages = await this.getSavedClaudeMessages()

		const lastClaudeMessage = this.claudeMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

		let askType: ClaudeAsk
		if (lastClaudeMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		const { response, text, images } = await this.ask(askType)

		let newUserContent: UserContent = []
		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			if (images && images.length > 0) {
				newUserContent.push(...this.formatImagesIntoBlocks(images))
			}
			if (text) {
				newUserContent.push({ type: "text", text })
			}
		}

		const existingApiConversationHistory: Anthropic.Messages.MessageParam[] =
			await this.getSavedApiConversationHistory()

		let modifiedOldUserContent: UserContent
		let modifiedApiConversationHistory: Anthropic.Messages.MessageParam[]
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use"
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: UserContent = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use"
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result"
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id)
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		// now we have newUserContent which is user's current message, and the modifiedOldUserContent which is the old message with tool responses filled in
		// we need to combine them while ensuring there is only one text block
		const modifiedOldUserContentText = modifiedOldUserContent.find((block) => block.type === "text")?.text
		const newUserContentText = newUserContent.find((block) => block.type === "text")?.text
		const agoText = (() => {
			const timestamp = lastClaudeMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		const combinedText =
			`Task resumption: This autonomous coding task was interrupted ${agoText}. It may or may not be complete, so please reassess the task context. Be aware that the project state may have changed since then. The current working directory is now ${cwd}. If the task has not been completed, retry the last step before interruption and proceed with completing the task.` +
			(modifiedOldUserContentText
				? `\n\nLast recorded user input before interruption:\n<previous_message>\n${modifiedOldUserContentText}\n</previous_message>\n`
				: "") +
			(newUserContentText
				? `\n\nNew instructions for task continuation:\n<user_message>\n${newUserContentText}\n</user_message>\n`
				: "") +
			`\n\n${this.getPotentiallyRelevantDetails()}`

		const combinedModifiedOldUserContentWithNewUserContent: UserContent = (
			modifiedOldUserContent.filter((block) => block.type !== "text") as UserContent
		).concat([{ type: "text", text: combinedText }])

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.initiateTaskLoop(combinedModifiedOldUserContentWithNewUserContent)
	}

	private async initiateTaskLoop(userContent: UserContent): Promise<void> {
		let nextUserContent = userContent

		while (!this.abort) {
			const { didEndLoop } = await this.recursivelyMakeClaudeRequests(nextUserContent)

			//  The way this agentic loop works is that claude will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite requests, but Claude is prompted to finish the task as efficiently as he can.

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if the user hits max requests and denies resetting the count.
				//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
				break
			} else {
				// this.say(
				// 	"tool",
				// 	"Claude responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
				// )
				nextUserContent = [
					{
						type: "text",
						text: "If you have completed the user's task, use the attempt_completion tool. If you require additional information from the user, use the ask_followup_question tool. Otherwise, if you have not completed the task and do not need additional information, then proceed with the next step of the task. (This is an automated message, so do not respond to it conversationally.)",
					},
				]
			}
		}
	}

	abortTask() {
		this.abort = true // will stop any autonomously running promises
		const runningProcessId = this.executeCommandRunningProcess?.pid
		if (runningProcessId) {
			treeKill(runningProcessId, "SIGTERM")
		}
	}

	async executeTool(toolName: ToolName, toolInput: any, isLastWriteToFile: boolean = false): Promise<ToolResponse> {
		switch (toolName) {
			case "write_to_file":
				return this.writeToFile(toolInput.path, toolInput.content, isLastWriteToFile)
			case "read_file":
				return this.readFile(toolInput.path)
			case "list_files_top_level":
				return this.listFilesTopLevel(toolInput.path)
			case "list_files_recursive":
				return this.listFilesRecursive(toolInput.path)
			case "view_source_code_definitions_top_level":
				return this.viewSourceCodeDefinitionsTopLevel(toolInput.path)
			case "execute_command":
				return this.executeCommand(toolInput.command)
			case "ask_followup_question":
				return this.askFollowupQuestion(toolInput.question)
			case "attempt_completion":
				return this.attemptCompletion(toolInput.result, toolInput.command)
			default:
				return `Unknown tool: ${toolName}`
		}
	}

	calculateApiCost(
		inputTokens: number,
		outputTokens: number,
		cacheCreationInputTokens?: number,
		cacheReadInputTokens?: number
	): number {
		const modelCacheWritesPrice = this.api.getModel().info.cacheWritesPrice
		let cacheWritesCost = 0
		if (cacheCreationInputTokens && modelCacheWritesPrice) {
			cacheWritesCost = (modelCacheWritesPrice / 1_000_000) * cacheCreationInputTokens
		}
		const modelCacheReadsPrice = this.api.getModel().info.cacheReadsPrice
		let cacheReadsCost = 0
		if (cacheReadInputTokens && modelCacheReadsPrice) {
			cacheReadsCost = (modelCacheReadsPrice / 1_000_000) * cacheReadInputTokens
		}
		const baseInputCost = (this.api.getModel().info.inputPrice / 1_000_000) * inputTokens
		const outputCost = (this.api.getModel().info.outputPrice / 1_000_000) * outputTokens
		const totalCost = cacheWritesCost + cacheReadsCost + baseInputCost + outputCost
		return totalCost
	}

	async writeToFile(relPath?: string, newContent?: string, isLast: boolean = true): Promise<ToolResponse> {
		if (relPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use write_to_file without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}

		if (newContent === undefined) {
			// Special message for this case since this tends to happen the most
			await this.say(
				"error",
				`Claude tried to use write_to_file for '${relPath}' without value for required parameter 'content'. This is likely due to output token limits. Retrying...`
			)
			return "Error: Missing value for required parameter 'content'. Please retry with complete response."
		}

		try {
			const absolutePath = path.resolve(cwd, relPath)
			const fileExists = await fs
				.access(absolutePath)
				.then(() => true)
				.catch(() => false)

			if (fileExists) {
				const originalContent = await fs.readFile(absolutePath, "utf-8")
				// fix issue where claude always removes newline from the file
				if (originalContent.endsWith("\n") && !newContent.endsWith("\n")) {
					newContent += "\n"
				}
				// condensed patch to return to claude
				const diffResult = diff.createPatch(absolutePath, originalContent, newContent)
				// full diff representation for webview
				const diffRepresentation = diff
					.diffLines(originalContent, newContent)
					.map((part) => {
						const prefix = part.added ? "+" : part.removed ? "-" : " "
						return (part.value || "")
							.split("\n")
							.map((line) => (line ? prefix + line : ""))
							.join("\n")
					})
					.join("")

				// Create virtual document with new file, then open diff editor
				const fileName = path.basename(absolutePath)
				vscode.commands.executeCommand(
					"vscode.diff",
					vscode.Uri.file(absolutePath),
					// to create a virtual doc we use a uri scheme registered in extension.ts, which then converts this base64 content into a text document
					// (providing file name with extension in the uri lets vscode know the language of the file and apply syntax highlighting)
					vscode.Uri.parse(`vsone-diff:${fileName}`).with({
						query: Buffer.from(newContent).toString("base64"),
					}),
					`${fileName}: Original ↔ Suggested Changes`
				)

				const { response, text, images } = await this.ask(
					"tool",
					JSON.stringify({
						tool: "editedExistingFile",
						path: this.getReadablePath(relPath),
						diff: diffRepresentation,
					} as ClaudeSayTool)
				)
				if (response !== "yesButtonTapped") {
					if (isLast) {
						await this.closeDiffViews()
					}
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
					}
					return "The user denied this operation."
				}
				await fs.writeFile(absolutePath, newContent)
				// Finish by opening the edited file in the editor
				await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
				if (isLast) {
					await this.closeDiffViews()
				}
				return `Changes applied to ${relPath}:\n${diffResult}`
			} else {
				const fileName = path.basename(absolutePath)
				vscode.commands.executeCommand(
					"vscode.diff",
					vscode.Uri.parse(`vsone-diff:${fileName}`).with({
						query: Buffer.from("").toString("base64"),
					}),
					vscode.Uri.parse(`vsone-diff:${fileName}`).with({
						query: Buffer.from(newContent).toString("base64"),
					}),
					`${fileName}: New File`
				)
				const { response, text, images } = await this.ask(
					"tool",
					JSON.stringify({
						tool: "newFileCreated",
						path: this.getReadablePath(relPath),
						content: newContent,
					} as ClaudeSayTool)
				)
				if (response !== "yesButtonTapped") {
					if (isLast) {
						await this.closeDiffViews()
					}
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
					}
					return "The user denied this operation."
				}
				await fs.mkdir(path.dirname(absolutePath), { recursive: true })
				await fs.writeFile(absolutePath, newContent)
				await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
				if (isLast) {
					await this.closeDiffViews()
				}
				return `New file created and content written to ${relPath}`
			}
		} catch (error) {
			const errorString = `Error writing file: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error writing file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return errorString
		}
	}

	async closeDiffViews() {
		const tabs = vscode.window.tabGroups.all
			.map((tg) => tg.tabs)
			.flat()
			.filter(
				(tab) =>
					tab.input instanceof vscode.TabInputTextDiff && tab.input?.modified?.scheme === "vsone-diff"
			)
		for (const tab of tabs) {
			await vscode.window.tabGroups.close(tab)
		}
	}

	async readFile(relPath?: string): Promise<ToolResponse> {
		if (relPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use read_file without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relPath)
			const content = await fs.readFile(absolutePath, "utf-8")
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({ tool: "readFile", path: this.getReadablePath(relPath), content } as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
				}
				return "The user denied this operation."
			}
			return content
		} catch (error) {
			const errorString = `Error reading file: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error reading file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return errorString
		}
	}

	async listFilesTopLevel(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use list_files_top_level without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const files = await listFiles(absolutePath, false)
			const result = this.formatFilesList(absolutePath, files)
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({
					tool: "listFilesTopLevel",
					path: this.getReadablePath(relDirPath),
					content: result,
				} as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
				}
				return "The user denied this operation."
			}
			return result
		} catch (error) {
			const errorString = `Error listing files and directories: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error listing files and directories:\n${
					error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return errorString
		}
	}

	async listFilesRecursive(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use list_files_recursive without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const files = await listFiles(absolutePath, true)
			const result = this.formatFilesList(absolutePath, files)
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({
					tool: "listFilesRecursive",
					path: this.getReadablePath(relDirPath),
					content: result,
				} as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
				}
				return "The user denied this operation."
			}
			return result
		} catch (error) {
			const errorString = `Error listing files recursively: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error listing files recursively:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return errorString
		}
	}

	getReadablePath(relPath: string): string {
		// path.resolve is flexible in that it will resolve relative paths like '../../' to the cwd and even ignore the cwd if the relPath is actually an absolute path
		const absolutePath = path.resolve(cwd, relPath)
		if (cwd === path.join(os.homedir(), "Desktop")) {
			// User opened vscode without a workspace, so cwd is the Desktop. Show the full absolute path to keep the user aware of where files are being created
			return absolutePath
		}
		if (path.normalize(absolutePath) === path.normalize(cwd)) {
			return path.basename(absolutePath)
		} else {
			// show the relative path to the cwd
			const normalizedRelPath = path.relative(cwd, absolutePath)
			if (absolutePath.includes(cwd)) {
				return normalizedRelPath
			} else {
				// we are outside the cwd, so show the absolute path (useful for when claude passes in '../../' for example)
				return absolutePath
			}
		}
	}

	formatFilesList(absolutePath: string, files: string[]): string {
		const sorted = files
			.map((file) => {
				// convert absolute path to relative path
				const relativePath = path.relative(absolutePath, file)
				return file.endsWith("/") ? relativePath + "/" : relativePath
			})
			.sort((a, b) => {
				// sort directories before files
				const aIsDir = a.endsWith("/")
				const bIsDir = b.endsWith("/")
				if (aIsDir !== bIsDir) {
					return aIsDir ? -1 : 1
				}
				return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
			})

		if (sorted.length > 1000) {
			const truncatedList = sorted.slice(0, 1000).join("\n")
			const remainingCount = sorted.length - 1000
			return `${truncatedList}\n\n(${remainingCount} files not listed due to automatic truncation. Try listing files in subdirectories if you need to explore further.)`
		} else if (sorted.length === 0 || (sorted.length === 1 && sorted[0] === "")) {
			return "No files found or you do not have permission to view this directory."
		} else {
			return sorted.join("\n")
		}
	}

	async viewSourceCodeDefinitionsTopLevel(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use view_source_code_definitions_top_level without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({
					tool: "viewSourceCodeDefinitionsTopLevel",
					path: this.getReadablePath(relDirPath),
					content: result,
				} as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
				}
				return "The user denied this operation."
			}
			return result
		} catch (error) {
			const errorString = `Error parsing source code definitions: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error parsing source code definitions:\n${
					error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return errorString
		}
	}

	async executeCommand(command?: string, returnEmptyStringOnSuccess: boolean = false): Promise<ToolResponse> {
		if (command === undefined) {
			await this.say(
				"error",
				"Claude tried to use execute_command without value for required parameter 'command'. Retrying..."
			)
			return "Error: Missing value for required parameter 'command'. Please retry with complete response."
		}
		const { response, text, images } = await this.ask("command", command)
		if (response !== "yesButtonTapped") {
			if (response === "messageResponse") {
				await this.say("user_feedback", text, images)
				return this.formatIntoToolResponse(this.formatGenericToolFeedback(text), images)
			}
			return "The user denied this operation."
		}

		const sendCommandOutput = async (subprocess: ResultPromise, line: string): Promise<void> => {
			try {
				const { response, text } = await this.ask("command_output", line)
				// if this ask promise is not ignored, that means the user responded to it somehow either by clicking primary button or by typing text
				if (response === "yesButtonTapped") {
					// SIGINT is typically what's sent when a user interrupts a process (like pressing Ctrl+C)
					/*
					.kill sends SIGINT by default. However by not passing any options into .kill(), execa internally sends a SIGKILL after a grace period if the SIGINT failed.
					however it turns out that even this isn't enough for certain processes like npm starting servers. therefore we use the tree-kill package to kill all processes in the process tree, including the root process.
					- Sends signal to all children processes of the process with pid pid, including pid. Signal defaults to SIGTERM.
					*/
					if (subprocess.pid) {
						//subprocess.kill("SIGINT") // will result in for loop throwing error
						treeKill(subprocess.pid, "SIGINT")
					}
				} else {
					// if the user sent some input, we send it to the command stdin
					// add newline as cli programs expect a newline after each input
					// (stdin needs to be set to `pipe` to send input to the command, execa does this by default when using template literals - other options are inherit (from parent process stdin) or null (no stdin))
					subprocess.stdin?.write(text + "\n")
					// Recurse with an empty string to continue listening for more input
					sendCommandOutput(subprocess, "") // empty strings are effectively ignored by the webview, this is done solely to relinquish control over the exit command button
				}
			} catch {
				// This can only happen if this ask promise was ignored, so ignore this error
			}
		}

		try {
			let result = ""
			// execa by default tries to convert bash into javascript, so need to specify `shell: true` to use sh on unix or cmd.exe on windows
			// also worth noting that execa`input` and the execa(command) have nuanced differences like the template literal version handles escaping for you, while with the function call, you need to be more careful about how arguments are passed, especially when using shell: true.
			// execa returns a promise-like object that is both a promise and a Subprocess that has properties like stdin
			const subprocess = execa({ shell: true, cwd: cwd })`${command}`
			this.executeCommandRunningProcess = subprocess

			subprocess.stdout?.on("data", (data) => {
				if (data) {
					const output = data.toString()
					// stream output to user in realtime
					// do not await since it's sent as an ask and we are not waiting for a response
					sendCommandOutput(subprocess, output)
					result += output
				}
			})

			try {
				await subprocess
				// NOTE: using for await to stream execa output does not return lines that expect user input, so we use listen to the stdout stream and handle data directly, allowing us to process output as soon as it's available even before a full line is complete.
				// for await (const chunk of subprocess) {
				// 	const line = chunk.toString()
				// 	sendCommandOutput(subprocess, line)
				// 	result += `${line}\n`
				// }
			} catch (e) {
				if ((e as ExecaError).signal === "SIGINT") {
					await this.say("command_output", `\nUser exited command...`)
					result += `\n====\nUser terminated command process via SIGINT. This is not an error. Please continue with your task, but keep in mind that the command is no longer running. For example, if this command was used to start a server for a react app, the server is no longer running and you cannot open a browser to view it anymore.`
				} else {
					throw e // if the command was not terminated by user, let outer catch handle it as a real error
				}
			}
			// Wait for a short delay to ensure all messages are sent to the webview
			// This delay allows time for non-awaited promises to be created and
			// for their associated messages to be sent to the webview, maintaining
			// the correct order of messages (although the webview is smart about
			// grouping command_output messages despite any gaps anyways)
			await delay(100)
			this.executeCommandRunningProcess = undefined
			// for attemptCompletion, we don't want to return the command output
			if (returnEmptyStringOnSuccess) {
				return ""
			}
			return `Command Output:\n${result}`
		} catch (e) {
			const error = e as any
			let errorMessage = error.message || JSON.stringify(serializeError(error), null, 2)
			const errorString = `Error executing command:\n${errorMessage}`
			await this.say("error", `Error executing command:\n${errorMessage}`) // TODO: in webview show code block for command errors
			this.executeCommandRunningProcess = undefined
			return errorString
		}
	}

	async askFollowupQuestion(question?: string): Promise<ToolResponse> {
		if (question === undefined) {
			await this.say(
				"error",
				"Claude tried to use ask_followup_question without value for required parameter 'question'. Retrying..."
			)
			return "Error: Missing value for required parameter 'question'. Please retry with complete response."
		}
		const { text, images } = await this.ask("followup", question)
		await this.say("user_feedback", text ?? "", images)
		return this.formatIntoToolResponse(`<answer>\n${text}\n</answer>`, images)
	}

	async attemptCompletion(result?: string, command?: string): Promise<ToolResponse> {
		// result is required, command is optional
		if (result === undefined) {
			await this.say(
				"error",
				"Claude tried to use attempt_completion without value for required parameter 'result'. Retrying..."
			)
			return "Error: Missing value for required parameter 'result'. Please retry with complete response."
		}
		let resultToSend = result
		if (command) {
			await this.say("completion_result", resultToSend)
			// TODO: currently we don't handle if this command fails, it could be useful to let claude know and retry
			const commandResult = await this.executeCommand(command, true)
			// if we received non-empty string, the command was rejected or failed
			if (commandResult) {
				return commandResult
			}
			resultToSend = ""
		}
		const { response, text, images } = await this.ask("completion_result", resultToSend) // this prompts webview to show 'new task' button, and enable text input (which would be the 'text' here)
		if (response === "yesButtonTapped") {
			return "" // signals to recursive loop to stop (for now this never happens since yesButtonTapped will trigger a new task)
		}
		await this.say("user_feedback", text ?? "", images)
		return this.formatIntoToolResponse(
			`The user is not pleased with the results. Use the feedback they provided to successfully complete the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
			images
		)
	}

	async attemptApiRequest(): Promise<Anthropic.Messages.Message> {
		try {
			let systemPrompt = SYSTEM_PROMPT()
			if (this.customInstructions && this.customInstructions.trim()) {
				// altering the system prompt mid-task will break the prompt cache, but in the grand scheme this will not change often so it's better to not pollute user messages with it the way we have to with <potentially relevant details>
				systemPrompt += `
====

USER'S CUSTOM INSTRUCTIONS

The following additional instructions are provided by the user. They should be followed and given precedence in case of conflicts with previous instructions.

${this.customInstructions.trim()}
`
			}
			return await this.api.createMessage(systemPrompt, this.apiConversationHistory, tools)
		} catch (error) {
			const { response } = await this.ask(
				"api_req_failed",
				error.message ?? JSON.stringify(serializeError(error), null, 2)
			)
			if (response !== "yesButtonTapped") {
				// this will never happen since if noButtonTapped, we will clear current task, aborting this instance
				throw new Error("API request failed")
			}
			await this.say("api_req_retried")
			return this.attemptApiRequest()
		}
	}

	async recursivelyMakeClaudeRequests(userContent: UserContent): Promise<ClaudeRequestResult> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}

		await this.addToApiConversationHistory({ role: "user", content: userContent })
		if (this.requestCount >= this.maxRequestsPerTask) {
			const { response } = await this.ask(
				"request_limit_reached",
				`ONE has reached the maximum number of requests for this task. Would you like to reset the count and allow him to proceed?`
			)

			if (response === "yesButtonTapped") {
				this.requestCount = 0
			} else {
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I have reached the request limit for this task. Do you have a new task for me?",
						},
					],
				})
				return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
			}
		}

		// what the user sees in the webview
		await this.say(
			"api_req_started",
			JSON.stringify({
				request: this.api.createUserReadableRequest(userContent),
			})
		)
		try {
			const response = await this.attemptApiRequest()
			this.requestCount++

			if (this.abort) {
				throw new Error("ClaudeDev instance aborted")
			}

			let assistantResponses: Anthropic.Messages.ContentBlock[] = []
			let inputTokens = response.usage.input_tokens
			let outputTokens = response.usage.output_tokens
			let cacheCreationInputTokens =
				(response as Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaMessage).usage
					.cache_creation_input_tokens || undefined
			let cacheReadInputTokens =
				(response as Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaMessage).usage
					.cache_read_input_tokens || undefined
			await this.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheCreationInputTokens,
					cacheReads: cacheReadInputTokens,
					cost: this.calculateApiCost(
						inputTokens,
						outputTokens,
						cacheCreationInputTokens,
						cacheReadInputTokens
					),
				})
			)

			// A response always returns text content blocks (it's just that before we were iterating over the completion_attempt response before we could append text response, resulting in bug)
			for (const contentBlock of response.content) {
				if (contentBlock.type === "text") {
					assistantResponses.push(contentBlock)
					await this.say("text", contentBlock.text)
				}
			}

			let toolResults: Anthropic.ToolResultBlockParam[] = []
			let attemptCompletionBlock: Anthropic.Messages.ToolUseBlock | undefined
			const writeToFileCount = response.content.filter(
				(block) => block.type === "tool_use" && (block.name as ToolName) === "write_to_file"
			).length
			let currentWriteToFile = 0
			for (const contentBlock of response.content) {
				if (contentBlock.type === "tool_use") {
					assistantResponses.push(contentBlock)
					const toolName = contentBlock.name as ToolName
					const toolInput = contentBlock.input
					const toolUseId = contentBlock.id
					if (toolName === "attempt_completion") {
						attemptCompletionBlock = contentBlock
					} else {
						if (toolName === "write_to_file") {
							currentWriteToFile++
						}
						// NOTE: while anthropic sdk accepts string or array of string/image, openai sdk (openrouter) only accepts a string
						const result = await this.executeTool(
							toolName,
							toolInput,
							currentWriteToFile === writeToFileCount
						)
						// this.say(
						// 	"tool",
						// 	`\nTool Used: ${toolName}\nTool Input: ${JSON.stringify(toolInput)}\nTool Result: ${result}`
						// )
						toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: result })
					}
				}
			}

			if (assistantResponses.length > 0) {
				await this.addToApiConversationHistory({ role: "assistant", content: assistantResponses })
			} else {
				// this should never happen! it there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				await this.say("error", "Unexpected Error: No assistant messages were found in the API response")
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not have a response to provide." }],
				})
			}

			let didEndLoop = false

			// attempt_completion is always done last, since there might have been other tools that needed to be called first before the job is finished
			// it's important to note that claude will order the tools logically in most cases, so we don't have to think about which tools make sense calling before others
			if (attemptCompletionBlock) {
				let result = await this.executeTool(
					attemptCompletionBlock.name as ToolName,
					attemptCompletionBlock.input
				)
				// this.say(
				// 	"tool",
				// 	`\nattempt_completion Tool Used: ${attemptCompletionBlock.name}\nTool Input: ${JSON.stringify(
				// 		attemptCompletionBlock.input
				// 	)}\nTool Result: ${result}`
				// )
				if (result === "") {
					didEndLoop = true
					result = "The user is satisfied with the result."
				}
				toolResults.push({ type: "tool_result", tool_use_id: attemptCompletionBlock.id, content: result })
			}

			if (toolResults.length > 0) {
				if (didEndLoop) {
					await this.addToApiConversationHistory({ role: "user", content: toolResults })
					await this.addToApiConversationHistory({
						role: "assistant",
						content: [
							{
								type: "text",
								text: "I am pleased you are satisfied with the result. Do you have a new task for me?",
							},
						],
					})
				} else {
					const {
						didEndLoop: recDidEndLoop,
						inputTokens: recInputTokens,
						outputTokens: recOutputTokens,
					} = await this.recursivelyMakeClaudeRequests(toolResults)
					didEndLoop = recDidEndLoop
					inputTokens += recInputTokens
					outputTokens += recOutputTokens
				}
			}

			return { didEndLoop, inputTokens, outputTokens }
		} catch (error) {
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonTapped, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
		}
	}

	// Prompts

	getPotentiallyRelevantDetails() {
		// TODO: add more details
		return `<potentially_relevant_details>
VSCode Visible Files: ${
			vscode.window.visibleTextEditors
				?.map((editor) => editor.document?.uri?.fsPath)
				.filter(Boolean)
				.join(", ") || "(No files open)"
		}
VSCode Opened Tabs: ${
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
				.filter(Boolean)
				.join(", ") || "(No tabs open)"
		}
</potentially_relevant_details>`
	}

	formatGenericToolFeedback(feedback?: string) {
		return `The user denied this operation and provided the following feedback:\n<feedback>\n${feedback}\n</feedback>\n\n${this.getPotentiallyRelevantDetails()}`
	}
}
