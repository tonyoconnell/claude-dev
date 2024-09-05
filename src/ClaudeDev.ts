import { Anthropic } from "@anthropic-ai/sdk"
import defaultShell from "default-shell"
import delay from "delay"
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
import { LIST_FILES_LIMIT, listFiles, parseSourceCodeForDefinitionsTopLevel } from "./parse-source-code"
import { ClaudeDevProvider } from "./providers/ClaudeDevProvider"
import { ApiConfiguration } from "./shared/api"
import { ClaudeRequestResult } from "./shared/ClaudeRequestResult"
import { combineApiRequests } from "./shared/combineApiRequests"
import { combineCommandSequences, COMMAND_STDIN_STRING } from "./shared/combineCommandSequences"
import { ClaudeAsk, ClaudeMessage, ClaudeSay, ClaudeSayTool } from "./shared/ExtensionMessage"
import { getApiMetrics } from "./shared/getApiMetrics"
import { HistoryItem } from "./shared/HistoryItem"
import { combineApiRequests } from "./shared/combineApiRequests"
import { combineCommandSequences } from "./shared/combineCommandSequences"
import { findLastIndex } from "./utils"

const SYSTEM_PROMPT =
	() => `You are Claude Dev, a highly skilled software developer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

====
 
CAPABILITIES

- You can read and analyze code in various programming languages, and can write clean, efficient, and well-documented code.
- You can debug complex issues and providing detailed explanations, offering architectural insights and design patterns.
- You have access to tools that let you execute CLI commands on the user's computer, list files in a directory (top level or recursively), extract source code definitions, read and write files, and ask follow-up questions. These tools help you effectively accomplish a wide range of tasks, such as writing code, making edits or improvements to existing files, understanding the current state of a project, performing system operations, and much more.
- You can use the list_files_recursive tool to get an overview of the project's file structure, which can provide key insights into the project from directory/file names (how developers conceptualize and organize their code) or file extensions (the language used). The list_files_top_level tool is better suited for generic directories you don't necessarily need the nested structure of, like the Desktop.
- You can use the view_source_code_definitions_top_level tool to get an overview of source code definitions for all files at the top level of a specified directory. This can be particularly useful when you need to understand the broader context and relationships between certain parts of the code. You may need to call this tool multiple times to understand various parts of the codebase related to the task.
	- For example, when asked to make edits or improvements you might use list_files_recursive to get an overview of the project's file structure, then view_source_code_definitions_top_level to get an overview of source code definitions for files located in relevant directories, then read_file to examine the contents of relevant files, analyze the code and suggest improvements or make necessary edits, then use the write_to_file tool to implement changes.
- The execute_command tool lets you run commands on the user's computer and should be used whenever you feel it can help accomplish the user's task. When you need to execute a CLI command, you must provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, since they are more flexible and easier to run. Interactive and long-running commands are allowed, since the user has the ability to send input to stdin and terminate the command on their own if needed.

====

RULES

- Your current working directory is: ${cwd}
- You cannot \`cd\` into a different directory to complete a task. You are stuck operating from '${cwd}', so be sure to pass in the correct 'path' parameter when using tools that require a path.
- Do not use the ~ character or $HOME to refer to the home directory.
- Before using the execute_command tool, you must first think about the SYSTEM INFORMATION context provided to understand the user's environment and tailor your commands to ensure they are compatible with their system. You must also consider if the command you need to run should be executed in a specific directory outside of the current working directory '${cwd}', and if so prepend with \`cd\`'ing into that directory && then executing the command (as one command since you are stuck operating from '${cwd}'). For example, if you needed to run \`npm install\` in a project outside of '${cwd}', you would need to prepend with a \`cd\` i.e. pseudocode for this would be \`cd (path to project) && (command, in this case npm install)\`.
- When editing files, always provide the complete file content in your response, regardless of the extent of changes. DO NOT use placeholder comments like '//rest of code unchanged' or '//code remains the same'. You MUST include all parts of the file, even if they haven't been modified.
- If you need to read or edit a file you have already read or edited, you can assume its contents have not changed since then (unless specified otherwise by the user) and skip using the read_file tool before proceeding.
- When creating a new project (such as an app, website, or any software project), organize all new files within a dedicated project directory unless the user specifies otherwise. Use appropriate file paths when writing files, as the write_to_file tool will automatically create any necessary directories. Structure the project logically, adhering to best practices for the specific type of project being created. Unless otherwise specified, new projects should be easily run without additional setup, for example most projects can be built in HTML, CSS, and JavaScript - which you can open in a browser.
- You must try to use multiple tools in one request when possible. For example if you were to create a website, you would use the write_to_file tool to create the necessary files with their appropriate contents all at once. Or if you wanted to analyze a project, you could use the read_file tool multiple times to look at several key files. This will help you accomplish the user's task more efficiently.
- Be sure to consider the type of project (e.g. Python, JavaScript, web application) when determining the appropriate structure and files to include. Also consider what files may be most relevant to accomplishing the task, for example looking at a project's manifest file would help you understand the project's dependencies, which you could incorporate into any code you write.
- When making changes to code, always consider the context in which the code is being used. Ensure that your changes are compatible with the existing codebase and that they follow the project's coding standards and best practices.
- Do not ask for more information than necessary. Use the tools provided to accomplish the user's request efficiently and effectively. When you've completed your task, you must use the attempt_completion tool to present the result to the user. The user may provide feedback, which you can use to make improvements and try again.
- You are only allowed to ask the user questions using the ask_followup_question tool. Use this tool only when you need additional details to complete a task, and be sure to use a clear and concise question that will help you move forward with the task. However if you can use the available tools to avoid having to ask the user questions, you should do so. For example if you need to know the name of a file, you can use the list files tool to get the name yourself. If the user refers to something vague, you can use the list_files_recursive tool to get a better understanding of the project to see if that helps you clear up any confusion.
- Your goal is to try to accomplish the user's task, NOT engage in a back and forth conversation.
- NEVER end completion_attempt with a question or request to engage in further conversation! Formulate the end of your result in a way that is final and does not require further input from the user. 
- NEVER start your responses with affirmations like "Certainly", "Okay", "Sure", "Great", etc. You should NOT be conversational in your responses, but rather direct and to the point.
- Feel free to use markdown as much as you'd like in your responses. When using code blocks, always include a language specifier.
- When presented with images, utilize your vision capabilities to thoroughly examine them and extract meaningful information. Incorporate these insights into your thought process as you accomplish the user's task.

====

OBJECTIVE

You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.

1. Analyze the user's task and set clear, achievable goals to accomplish it. Prioritize these goals in a logical order.
2. Work through these goals sequentially, utilizing available tools as necessary. Each goal should correspond to a distinct step in your problem-solving process. It is okay for certain steps to take multiple iterations, i.e. if you need to create many files but are limited by your max output limitations, it's okay to create a few files at a time as each subsequent iteration will keep you informed on the work completed and what's remaining. 
3. Remember, you have extensive capabilities with access to a wide range of tools that can be used in powerful and clever ways as necessary to accomplish each goal. Before calling a tool, do some analysis within <thinking></thinking> tags. First, think about which of the provided tools is the relevant tool to answer the user's request. Second, go through each of the required parameters of the relevant tool and determine if the user has directly provided or given enough information to infer a value. When deciding if the parameter can be inferred, carefully consider all the context to see if it supports a specific value. If all of the required parameters are present or can be reasonably inferred, close the thinking tag and proceed with the tool call. BUT, if one of the values for a required parameter is missing, DO NOT invoke the function (not even with fillers for the missing params) and instead, ask the user to provide the missing parameters using the ask_followup_question tool. DO NOT ask for more information on optional parameters if it is not provided.
4. Once you've completed the user's task, you must use the attempt_completion tool to present the result of the task to the user. You may also provide a CLI command to showcase the result of your task; this can be particularly useful for web development tasks, where you can run e.g. \`open index.html\` to show the website you've built.
5. The user may provide feedback, which you can use to make improvements and try again. But DO NOT continue in pointless back and forth conversations, i.e. don't end your responses with questions or offers for further assistance.

====

SYSTEM INFORMATION

Operating System: ${osName()}
Default Shell: ${defaultShell}
Home Directory: ${os.homedir()}
Current Working Directory: ${cwd}
`

const cwd =
	vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop")

const tools: Tool[] = [
	{
		name: "execute_command",
		description: `Execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Commands will be executed in the current working directory: ${cwd}`,
		input_schema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "list_files_top_level",
		description:
			"List all files and directories at the top level of the specified directory. This should only be used for generic directories you don't necessarily need the nested structure of, like the Desktop.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the directory to list contents for (relative to the current working directory ${cwd})`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_files_recursive",
		description:
			"Recursively list all files and directories within the specified directory. This provides a comprehensive view of the project structure, and can guide decision-making on which files to process or explore further.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the directory to recursively list contents for (relative to the current working directory ${cwd})`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "view_source_code_definitions_top_level",
		description:
			"Parse all source code files at the top level of the specified directory to extract names of key elements like classes and functions. This tool provides insights into the codebase structure and important constructs, encapsulating high-level concepts and relationships that are crucial for understanding the overall architecture.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the directory (relative to the current working directory ${cwd}) to parse top level source code files for to view their definitions`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "read_file",
		description:
			"Read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file, for example to analyze code, review text files, or extract information from configuration files. Be aware that this tool may not be suitable for very large files or binary files, as it returns the raw content as a string.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the file to read (relative to the current working directory ${cwd})`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_to_file",
		description:
			"Write content to a file at the specified path. If the file exists, it will be overwritten with the provided content. If the file doesn't exist, it will be created. Always provide the full intended content of the file, without any truncation. This tool will automatically create any directories needed to write the file.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the file to write to (relative to the current working directory ${cwd})`,
				},
				content: {
					type: "string",
					description: "The full content to write to the file.",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "ask_followup_question",
		description:
			"Ask the user a question to gather additional information needed to complete the task. This tool should be used when you encounter ambiguities, need clarification, or require more details to proceed effectively. It allows for interactive problem-solving by enabling direct communication with the user. Use this tool judiciously to maintain a balance between gathering necessary information and avoiding excessive back-and-forth.",
		input_schema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description:
						"The question to ask the user. This should be a clear, specific question that addresses the information you need.",
				},
			},
			required: ["question"],
		},
	},
	{
		name: "attempt_completion",
		description:
			"Once you've completed the task, use this tool to present the result to the user. They may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.",
		input_schema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The CLI command to execute to show a live demo of the result to the user. For example, use 'open index.html' to display a created website. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.",
				},
				result: {
					type: "string",
					description:
						"The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.",
				},
			},
			required: ["result"],
		},
	},
]

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<
	Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>

export class ClaudeDev {
	readonly taskId: string
	private api: ApiHandler
	private customInstructions?: string
	private alwaysAllowReadOnly: boolean
	apiConversationHistory: Anthropic.MessageParam[] = []
	claudeMessages: ClaudeMessage[] = []
	private askResponse?: ClaudeAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private lastMessageTs?: number
	private executeCommandRunningProcess?: ResultPromise
	private consecutiveMistakeCount: number = 0
	private shouldSkipNextApiReqStartedMessage = false
	private providerRef: WeakRef<ClaudeDevProvider>
	private abort: boolean = false

	constructor(
		provider: ClaudeDevProvider,
		apiConfiguration: ApiConfiguration,
		customInstructions?: string,
		alwaysAllowReadOnly?: boolean,
		task?: string,
		images?: string[],
		historyItem?: HistoryItem
	) {
		this.providerRef = new WeakRef(provider)
		this.api = buildApiHandler(apiConfiguration)
		this.customInstructions = customInstructions
		this.alwaysAllowReadOnly = alwaysAllowReadOnly ?? false

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

	updateCustomInstructions(customInstructions: string | undefined) {
		this.customInstructions = customInstructions
	}

	updateAlwaysAllowReadOnly(alwaysAllowReadOnly: boolean | undefined) {
		this.alwaysAllowReadOnly = alwaysAllowReadOnly ?? false
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
			const taskMessage = this.claudeMessages[0] // first message is always the task say
			await this.providerRef.deref()?.updateTaskHistory({
				id: this.taskId,
				ts: lastRelevantMessage.ts,
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
			text: `<task>\n${task}\n</task>\n\n${this.getPotentiallyRelevantDetails()}`, // cannot be sent with system prompt since it's cached and these details can change
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
			`\n\n${await this.getPotentiallyRelevantDetails()}`

		const newUserContentImages = newUserContent.filter((block) => block.type === "image")
		const combinedModifiedOldUserContentWithNewUserContent: UserContent = (
			modifiedOldUserContent.filter((block) => block.type !== "text") as UserContent
		).concat([{ type: "text", text: combinedText }, ...newUserContentImages])

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
				this.consecutiveMistakeCount++
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

	async executeTool(toolName: ToolName, toolInput: any): Promise<ToolResponse> {
		switch (toolName) {
			case "write_to_file":
				return this.writeToFile(toolInput.path, toolInput.content)
			case "read_file":
				return this.readFile(toolInput.path)
			case "list_files":
				return this.listFiles(toolInput.path, toolInput.recursive)
			case "list_code_definition_names":
				return this.listCodeDefinitionNames(toolInput.path)
			case "search_files":
				return this.searchFiles(toolInput.path, toolInput.regex, toolInput.filePattern)
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

	async writeToFile(relPath?: string, newContent?: string): Promise<ToolResponse> {
		if (relPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use write_to_file without value for required parameter 'path'. Retrying..."
			)
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}

		if (newContent === undefined) {
			await this.say(
				"error",
				`Claude tried to use write_to_file for '${relPath}' without value for required parameter 'content'. This is likely due to output token limits. Retrying...`
			)
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'content'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relPath)
			const fileExists = await fs
				.access(absolutePath)
				.then(() => true)
				.catch(() => false)

			let originalContent: string
			if (fileExists) {
				originalContent = await fs.readFile(absolutePath, "utf-8")
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
					vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
						query: Buffer.from(newContent).toString("base64"),
					}),
					`${fileName}: Original ↔ Suggested Changes`
				)

				const { response, text, images } = await this.ask(
					"tool",
					JSON.stringify({
						tool: "editedExistingFile",
						path: this.getReadablePath(relPath),
						diff: this.createPrettyPatch(relPath, originalContent, newContent),
					} as ClaudeSayTool)
				)
			} else {
				const fileName = path.basename(absolutePath)
				vscode.commands.executeCommand(
					"vscode.diff",
					vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
						query: Buffer.from("").toString("base64"),
					}),
					vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
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
			}
			const { response, text, images } = userResponse

			const closeInMemoryDocAndDiffViews = async () => {
				// ensure that the in-memory doc is active editor (this seems to fail on windows machines if its already active, so ignoring if there's an error as it's likely it's already active anyways)
				try {
					await vscode.window.showTextDocument(inMemoryDocument, {
						preview: true,
						preserveFocus: false,
					})
					// await vscode.window.showTextDocument(inMemoryDocument.uri, { preview: true, preserveFocus: false })
				} catch (error) {
					console.log(`Could not open editor for ${absolutePath}: ${error}`)
				}

				await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor") // allows us to close the untitled doc without being prompted to save it
				await this.closeDiffViews()
			}

			if (response !== "yesButtonTapped") {
				await closeInMemoryDocAndDiffViews()
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(await this.formatGenericToolFeedback(text), images)
				}
				return "The user denied this operation."
			}

			// Read the potentially edited content from the in-memory document
			const editedContent = inMemoryDocument.getText()
			if (!fileExists) {
				await fs.mkdir(path.dirname(absolutePath), { recursive: true })
			}
			await fs.writeFile(absolutePath, editedContent)

			await closeInMemoryDocAndDiffViews()

			// Finish by opening the edited file in the editor
			// calling showTextDocument would sometimes fail even though changes were applied, so we'll ignore these one-off errors (likely due to vscode locking issues)
			try {
				const openEditor = vscode.window.visibleTextEditors.find((editor) => {
					return editor.document.uri.fsPath === absolutePath
				})
				if (openEditor) {
					// File is already open, show the tab and focus on it
					await vscode.window.showTextDocument(openEditor.document, openEditor.viewColumn)
				} else {
					// If not open, open the file
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))
					await vscode.window.showTextDocument(document, { preview: false })
				}
			} catch (error) {
				// Handle errors more gracefully
				console.log(`Could not open editor for ${absolutePath}: ${error}`)
			}
			// await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })

			// If the edited content has different EOL characters, we don't want to show a diff with all the EOL differences.
			const newContentEOL = newContent.includes("\r\n") ? "\r\n" : "\n"
			const normalizedEditedContent = editedContent.replace(/\r\n|\n/g, newContentEOL)
			const normalizedNewContent = newContent.replace(/\r\n|\n/g, newContentEOL) // just in case the new content has a mix of varying EOL characters
			if (normalizedEditedContent !== normalizedNewContent) {
				const userDiff = diff.createPatch(relPath, normalizedNewContent, normalizedEditedContent)
				await this.say(
					"user_feedback_diff",
					JSON.stringify({
						tool: fileExists ? "editedExistingFile" : "newFileCreated",
						path: this.getReadablePath(relPath),
						diff: this.createPrettyPatch(relPath, normalizedNewContent, normalizedEditedContent),
					} as ClaudeSayTool)
				)
				return `The user made the following updates to your content:\n\n${userDiff}\n\nThe updated content was successfully saved to ${relPath}.`
			} else {
				return `The content was successfully saved to ${relPath}.`
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

	createPrettyPatch(filename = "file", oldStr: string, newStr: string) {
		const patch = diff.createPatch(filename, oldStr, newStr)
		const lines = patch.split("\n")
		const prettyPatchLines = lines.slice(4)
		return prettyPatchLines.join("\n")
	}

	async closeDiffViews() {
		const tabs = vscode.window.tabGroups.all
			.map((tg) => tg.tabs)
			.flat()
			.filter(
				(tab) =>
					tab.input instanceof vscode.TabInputTextDiff && tab.input?.modified?.scheme === "claude-dev-diff"
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
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relPath)
			const content = await extractTextFromFile(absolutePath)

			const message = JSON.stringify({
				tool: "readFile",
				path: this.getReadablePath(relPath),
				content,
			} as ClaudeSayTool)
			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(await this.formatGenericToolFeedback(text), images)
					}
					return "The user denied this operation."
				}
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

	async listFiles(relDirPath?: string, recursiveRaw?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use list_files without value for required parameter 'path'. Retrying..."
			)
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
		try {
			const recursive = recursiveRaw?.toLowerCase() === "true"
			const absolutePath = path.resolve(cwd, relDirPath)
			const files = await listFiles(absolutePath, recursive)
			const result = this.formatFilesList(absolutePath, files)

			const message = JSON.stringify({
				tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
				path: this.getReadablePath(relDirPath),
				content: result,
			} as ClaudeSayTool)
			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(await this.formatGenericToolFeedback(text), images)
					}
					return "The user denied this operation."
				}
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
			// Sort so files are listed under their respective directories to make it clear what files are children of what directories. Since we build file list top down, even if file list is truncated it will show directories that claude can then explore further.
			.sort((a, b) => {
				const aParts = a.split("/")
				const bParts = b.split("/")
				for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
					if (aParts[i] !== bParts[i]) {
						// If one is a directory and the other isn't at this level, sort the directory first
						if (i + 1 === aParts.length && i + 1 < bParts.length) {
							return -1
						}
						if (i + 1 === bParts.length && i + 1 < aParts.length) {
							return 1
						}
						// Otherwise, sort alphabetically
						return aParts[i].localeCompare(bParts[i], undefined, { numeric: true, sensitivity: "base" })
					}
				}
				// If all parts are the same up to the length of the shorter path,
				// the shorter one comes first
				return aParts.length - bParts.length
			})
		if (sorted.length >= LIST_FILES_LIMIT) {
			const truncatedList = sorted.slice(0, LIST_FILES_LIMIT).join("\n")
			return `${truncatedList}\n\n(Truncated at ${LIST_FILES_LIMIT} results. Try listing files in subdirectories if you need to explore further.)`
		} else if (sorted.length === 0 || (sorted.length === 1 && sorted[0] === "")) {
			return "No files found or you do not have permission to view this directory."
		} else {
			return sorted.join("\n")
		}
	}

	async listCodeDefinitionNames(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use list_code_definition_names without value for required parameter 'path'. Retrying..."
			)
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)

			const message = JSON.stringify({
				tool: "listCodeDefinitionNames",
				path: this.getReadablePath(relDirPath),
				content: result,
			} as ClaudeSayTool)
			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(await this.formatGenericToolFeedback(text), images)
					}
					return "The user denied this operation."
				}
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

	async searchFiles(relDirPath: string, regex: string, filePattern?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			await this.say(
				"error",
				"Claude tried to use search_files without value for required parameter 'path'. Retrying..."
			)
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		if (regex === undefined) {
			await this.say(
				"error",
				`Claude tried to use search_files without value for required parameter 'regex'. Retrying...`
			)
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'regex'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const results = await regexSearchFiles(cwd, absolutePath, regex, filePattern)

			const message = JSON.stringify({
				tool: "searchFiles",
				path: this.getReadablePath(relDirPath),
				regex: regex,
				filePattern: filePattern,
				content: results,
			} as ClaudeSayTool)

			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(await this.formatGenericToolFeedback(text), images)
					}
					return "The user denied this operation."
				}
			}

			return results
		} catch (error) {
			const errorString = `Error searching files: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error searching files:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
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
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'command'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
		const { response, text, images } = await this.ask("command", command)
		if (response !== "yesButtonTapped") {
			if (response === "messageResponse") {
				await this.say("user_feedback", text, images)
				return this.formatIntoToolResponse(await this.formatGenericToolFeedback(text), images)
			}
			return "The user denied this operation."
		}

		let userFeedback: { text?: string; images?: string[] } | undefined
		const sendCommandOutput = async (subprocess: ResultPromise, line: string): Promise<void> => {
			try {
				const { response, text, images } = await this.ask("command_output", line)
				const isStdin = (text ?? "").startsWith(COMMAND_STDIN_STRING)
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
					if (isStdin) {
						const stdin = text?.slice(COMMAND_STDIN_STRING.length) ?? ""

						// replace last commandoutput with + stdin
						const lastCommandOutput = findLastIndex(this.claudeMessages, (m) => m.ask === "command_output")
						if (lastCommandOutput !== -1) {
							this.claudeMessages[lastCommandOutput].text += stdin
						}

						// if the user sent some input, we send it to the command stdin
						// add newline as cli programs expect a newline after each input
						// (stdin needs to be set to `pipe` to send input to the command, execa does this by default when using template literals - other options are inherit (from parent process stdin) or null (no stdin))
						subprocess.stdin?.write(stdin + "\n")
						// Recurse with an empty string to continue listening for more input
						sendCommandOutput(subprocess, "") // empty strings are effectively ignored by the webview, this is done solely to relinquish control over the exit command button
					} else {
						userFeedback = { text, images }
						if (subprocess.pid) {
							treeKill(subprocess.pid, "SIGINT")
						}
					}
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
					//await this.say("command_output", `\nUser exited command...`)
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

			if (userFeedback) {
				await this.say("user_feedback", userFeedback.text, userFeedback.images)
				return this.formatIntoToolResponse(
					`Command Output:\n${result}\n\nThe user interrupted the command and provided the following feedback:\n<feedback>\n${
						userFeedback.text
					}\n</feedback>\n\n${await this.getPotentiallyRelevantDetails()}`,
					userFeedback.images
				)
			}

			// for attemptCompletion, we don't want to return the command output
			if (returnEmptyStringOnSuccess) {
				return ""
			}
			return `Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`
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
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'question'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
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
			this.consecutiveMistakeCount++
			return "Error: Missing value for required parameter 'result'. Please retry with complete response."
		}
		this.consecutiveMistakeCount = 0
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
			let systemPrompt = await SYSTEM_PROMPT()
			if (this.customInstructions && this.customInstructions.trim()) {
				// altering the system prompt mid-task will break the prompt cache, but in the grand scheme this will not change often so it's better to not pollute user messages with it the way we have to with <potentially relevant details>
				systemPrompt += `
====

USER'S CUSTOM INSTRUCTIONS

The following additional instructions are provided by the user. They should be followed and given precedence in case of conflicts with previous instructions.

${this.customInstructions.trim()}
`
			}

			// If the last API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
			const lastApiReqFinished = findLast(this.claudeMessages, (m) => m.say === "api_req_finished")
			if (lastApiReqFinished && lastApiReqFinished.text) {
				const {
					tokensIn,
					tokensOut,
					cacheWrites,
					cacheReads,
				}: { tokensIn?: number; tokensOut?: number; cacheWrites?: number; cacheReads?: number } = JSON.parse(
					lastApiReqFinished.text
				)
				const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				const contextWindow = this.api.getModel().info.contextWindow
				const maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8)
				if (totalTokens >= maxAllowedSize) {
					const truncatedMessages = truncateHalfConversation(this.apiConversationHistory)
					await this.overwriteApiConversationHistory(truncatedMessages)
				}
			}
			const { message, userCredits } = await this.api.createMessage(
				systemPrompt,
				this.apiConversationHistory,
				tools
			)
			if (userCredits !== undefined) {
				console.log("Updating credits", userCredits)
				// TODO: update credits
			}
			return message
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
				`Claude Dev has reached the maximum number of requests for this task. Would you like to reset the count and allow him to proceed?`
			)
			if (response === "messageResponse") {
				userContent.push(
					...[
						{
							type: "text",
							text: `You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:\n<feedback>\n${text}\n</feedback>\n\n${await this.getPotentiallyRelevantDetails()}`,
						} as Anthropic.Messages.TextBlockParam,
						...this.formatImagesIntoBlocks(images),
					]
				)
			}
			this.consecutiveMistakeCount = 0
		}

		await this.addToApiConversationHistory({ role: "user", content: userContent })

		if (!this.shouldSkipNextApiReqStartedMessage) {
			await this.say(
				"api_req_started",
				// what the user sees in the webview
				JSON.stringify({
					request: this.api.createUserReadableRequest(userContent),
				})
			)
		} else {
			this.shouldSkipNextApiReqStartedMessage = false
		}
		try {
			const response = await this.attemptApiRequest()

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
			for (const contentBlock of response.content) {
				if (contentBlock.type === "tool_use") {
					assistantResponses.push(contentBlock)
					const toolName = contentBlock.name as ToolName
					const toolInput = contentBlock.input
					const toolUseId = contentBlock.id
					if (toolName === "attempt_completion") {
						attemptCompletionBlock = contentBlock
					} else {
						// NOTE: while anthropic sdk accepts string or array of string/image, openai sdk (openrouter) only accepts a string
						const result = await this.executeTool(toolName, toolInput)
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

	async getPotentiallyRelevantDetails(verbose: boolean = false) {
		let details = `<potentially_relevant_details>
# VSCode Visible Files:
${
	vscode.window.visibleTextEditors
		?.map((editor) => editor.document?.uri?.fsPath)
		.filter(Boolean)
		.map((absolutePath) => path.relative(cwd, absolutePath))
		.join("\n") || "(No files open)"
}

# VSCode Opened Tabs:
${
	vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
		.filter(Boolean)
		.map((absolutePath) => path.relative(cwd, absolutePath))
		.join("\n") || "(No tabs open)"
}
`

		if (verbose) {
			const isDesktop = cwd === path.join(os.homedir(), "Desktop")
			const files = await listFiles(cwd, !isDesktop)
			const result = this.formatFilesList(cwd, files)
			details += `\n# Current Working Directory ('${cwd}') File Structure:${
				isDesktop
					? "\n(Desktop so only top-level contents shown for brevity, use list_files to explore further if necessary)"
					: ""
			}:\n${result}\n`
		}

		details += "</potentially_relevant_details>"
		return details
	}

	async formatGenericToolFeedback(feedback?: string) {
		return `The user denied this operation and provided the following feedback:\n<feedback>\n${feedback}\n</feedback>\n\n${await this.getPotentiallyRelevantDetails()}`
	}
}
