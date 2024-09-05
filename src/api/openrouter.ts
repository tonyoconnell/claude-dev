import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { ApiHandler, withoutImageData } from "."
import {
	ApiHandlerOptions,
	ModelInfo,
	openRouterDefaultModelId,
	OpenRouterModelId,
	openRouterModels,
} from "../shared/api"

export class OpenRouterHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: this.options.openRouterApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/one-ie/vsone", // Optional, for including your app on openrouter.ai rankings.
				"X-Title": "vsone", // Optional. Shows in rankings on openrouter.ai.
			},
		})
	}

	async createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		tools: Anthropic.Messages.Tool[]
	): Promise<Anthropic.Messages.Message> {
		// Convert Anthropic messages to OpenAI format
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...this.convertToOpenAiMessages(messages),
		]

		// Convert Anthropic tools to OpenAI tools
		const openAiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.input_schema, // matches anthropic tool input schema (see https://platform.openai.com/docs/guides/function-calling)
			},
		}))

		const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
			model: this.getModel().id,
			max_tokens: this.getModel().info.maxTokens,
			messages: openAiMessages,
			tools: openAiTools,
			tool_choice: "auto",
		}

		let completion: OpenAI.Chat.Completions.ChatCompletion
		try {
			completion = await this.client.chat.completions.create(createParams)
		} catch (error) {
			console.error("Error creating message from normal request. Using streaming fallback...", error)
			completion = await this.streamCompletion(createParams)
		}

		const errorMessage = (completion as any).error?.message // openrouter returns an error object instead of the openai sdk throwing an error
		if (errorMessage) {
			throw new Error(errorMessage)
		}

		// Convert OpenAI response to Anthropic format
		const openAiMessage = completion.choices[0].message
		const anthropicMessage: Anthropic.Messages.Message = {
			id: completion.id,
			type: "message",
			role: openAiMessage.role, // always "assistant"
			content: [
				{
					type: "text",
					text: openAiMessage.content || "",
				},
			],
			model: completion.model,
			stop_reason: (() => {
				switch (completion.choices[0].finish_reason) {
					case "stop":
						return "end_turn"
					case "length":
						return "max_tokens"
					case "tool_calls":
						return "tool_use"
					case "content_filter": // Anthropic doesn't have an exact equivalent
					default:
						return null
				}
			})(),
			stop_sequence: null, // which custom stop_sequence was generated, if any (not applicable if you don't use stop_sequence)
			usage: {
				input_tokens: completion.usage?.prompt_tokens || 0,
				output_tokens: completion.usage?.completion_tokens || 0,
			},
		}

		if (openAiMessage.tool_calls && openAiMessage.tool_calls.length > 0) {
			anthropicMessage.content.push(
				...openAiMessage.tool_calls.map((toolCall): Anthropic.ToolUseBlock => {
					let parsedInput = {}
					try {
						parsedInput = JSON.parse(toolCall.function.arguments || "{}")
					} catch (error) {
						console.error("Failed to parse tool arguments:", error)
					}
					return {
						type: "tool_use",
						id: toolCall.id,
						name: toolCall.function.name,
						input: parsedInput,
					}
				})
			)
		}

		return anthropicMessage
	}

	convertToOpenAiMessages(
		anthropicMessages: Anthropic.Messages.MessageParam[]
	): OpenAI.Chat.ChatCompletionMessageParam[] {
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

		for (const anthropicMessage of anthropicMessages) {
			if (typeof anthropicMessage.content === "string") {
				openAiMessages.push({ role: anthropicMessage.role, content: anthropicMessage.content })
			} else {
				// image_url.url is base64 encoded image data
				// ensure it contains the content-type of the image: data:image/png;base64,
				/*
			{ role: "user", content: "" | { type: "text", text: string } | { type: "image_url", image_url: { url: string } } },
			 // content required unless tool_calls is present
			{ role: "assistant", content?: "" | null, tool_calls?: [{ id: "", function: { name: "", arguments: "" }, type: "function" }] },
			{ role: "tool", tool_call_id: "", content: ""}
			 */
				if (anthropicMessage.role === "user") {
					const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
						nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
						toolMessages: Anthropic.ToolResultBlockParam[]
					}>(
						(acc, part) => {
							if (part.type === "tool_result") {
								acc.toolMessages.push(part)
							} else if (part.type === "text" || part.type === "image") {
								acc.nonToolMessages.push(part)
							} // user cannot send tool_use messages
							return acc
						},
						{ nonToolMessages: [], toolMessages: [] }
					)

					// Process non-tool messages
					if (nonToolMessages.length > 0) {
						openAiMessages.push({
							role: "user",
							content: nonToolMessages.map((part) => {
								if (part.type === "image") {
									return {
										type: "image_url",
										image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
									}
								}
								return { type: "text", text: part.text }
							}),
						})
					}

					// Process tool result messages
					let toolResultImages: Anthropic.Messages.ImageBlockParam[] = []
					toolMessages.forEach((toolMessage) => {
						// The Anthropic SDK allows tool results to be a string or an array of text and image blocks, enabling rich and structured content. In contrast, the OpenAI SDK only supports tool results as a single string, so we map the Anthropic tool result parts into one concatenated string to maintain compatibility.
						let content: string

						if (typeof toolMessage.content === "string") {
							content = toolMessage.content
						} else {
							content =
								toolMessage.content
									?.map((part) => {
										if (part.type === "image") {
											toolResultImages.push(part)
											return "(see following user message for image)"
										}
										return part.text
									})
									.join("\n") ?? ""
						}
						openAiMessages.push({
							role: "tool",
							tool_call_id: toolMessage.tool_use_id,
							content: content,
						})
					})

					// If tool results contain images, send as a separate user message
					// I ran into an issue where if I gave feedback for one of many tool uses, the request would fail.
					// "Messages following `tool_use` blocks must begin with a matching number of `tool_result` blocks."
					// Therefore we need to send these images after the tool result messages
					if (toolResultImages.length > 0) {
						openAiMessages.push({
							role: "user",
							content: toolResultImages.map((part) => ({
								type: "image_url",
								image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
							})),
						})
					}
				} else if (anthropicMessage.role === "assistant") {
					const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
						nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
						toolMessages: Anthropic.ToolUseBlockParam[]
					}>(
						(acc, part) => {
							if (part.type === "tool_use") {
								acc.toolMessages.push(part)
							} else if (part.type === "text" || part.type === "image") {
								acc.nonToolMessages.push(part)
							} // assistant cannot send tool_result messages
							return acc
						},
						{ nonToolMessages: [], toolMessages: [] }
					)

					// Process non-tool messages
					let content: string | undefined
					if (nonToolMessages.length > 0) {
						content = nonToolMessages
							.map((part) => {
								if (part.type === "image") {
									return "" // impossible as the assistant cannot send images
								}
								return part.text
							})
							.join("\n")
					}

					// Process tool use messages
					let tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolMessages.map((toolMessage) => ({
						id: toolMessage.id,
						type: "function",
						function: {
							name: toolMessage.name,
							// json string
							arguments: JSON.stringify(toolMessage.input),
						},
					}))

					openAiMessages.push({
						role: "assistant",
						content,
						// Cannot be an empty array. API expects an array with minimum length 1, and will respond with an error if it's empty
						tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
					})
				}
			}
		}

		return openAiMessages
	}

	/*
	Streaming the completion is a fallback behavior for when a normal request responds with an invalid JSON object ("Unexpected end of JSON input"). This would usually happen in cases where the model makes tool calls with large arguments. After talking with OpenRouter folks, streaming mitigates this issue for now until they fix the underlying problem ("some weird data from anthropic got decoded wrongly and crashed the buffer")
	*/
	async streamCompletion(
		createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
	): Promise<OpenAI.Chat.Completions.ChatCompletion> {
		const stream = await this.client.chat.completions.create({
			...createParams,
			stream: true,
		})

		let textContent: string = ""
		let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

		try {
			let currentToolCall: (OpenAI.Chat.ChatCompletionMessageToolCall & { index?: number }) | null = null
			for await (const chunk of stream) {
				const delta = chunk.choices[0]?.delta
				if (delta?.content) {
					textContent += delta.content
				}
				if (delta?.tool_calls) {
					for (const toolCallDelta of delta.tool_calls) {
						if (toolCallDelta.index === undefined) {
							continue
						}
						if (!currentToolCall || currentToolCall.index !== toolCallDelta.index) {
							// new index means new tool call, so add the previous one to the list
							if (currentToolCall) {
								toolCalls.push(currentToolCall)
							}
							currentToolCall = {
								index: toolCallDelta.index,
								id: toolCallDelta.id || "",
								type: "function",
								function: { name: "", arguments: "" },
							}
						}
						if (toolCallDelta.id) {
							currentToolCall.id = toolCallDelta.id
						}
						if (toolCallDelta.type) {
							currentToolCall.type = toolCallDelta.type
						}
						if (toolCallDelta.function) {
							if (toolCallDelta.function.name) {
								currentToolCall.function.name = toolCallDelta.function.name
							}
							if (toolCallDelta.function.arguments) {
								currentToolCall.function.arguments =
									(currentToolCall.function.arguments || "") + toolCallDelta.function.arguments
							}
						}
					}
				}
			}
			if (currentToolCall) {
				toolCalls.push(currentToolCall)
			}
		} catch (error) {
			console.error("Error streaming completion:", error)
			throw error
		}

		// Usage information is not available in streaming responses, so we need to estimate token counts
		function approximateTokenCount(text: string): number {
			return Math.ceil(new TextEncoder().encode(text).length / 4)
		}
		const promptTokens = approximateTokenCount(
			createParams.messages
				.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
				.join(" ")
		)
		const completionTokens = approximateTokenCount(
			textContent + toolCalls.map((toolCall) => toolCall.function.arguments || "").join(" ")
		)

		const completion: OpenAI.Chat.Completions.ChatCompletion = {
			created: Date.now(),
			object: "chat.completion",
			id: `openrouter-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`, // this ID won't be traceable back to OpenRouter's systems if you need to debug issues
			choices: [
				{
					message: {
						role: "assistant",
						content: textContent,
						tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
					},
					finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
					index: 0,
					logprobs: null,
				},
			],
			model: this.getModel().id,
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			},
		}

		return completion
	}

	createUserReadableRequest(
		userContent: Array<
			| Anthropic.TextBlockParam
			| Anthropic.ImageBlockParam
			| Anthropic.ToolUseBlockParam
			| Anthropic.ToolResultBlockParam
		>
	): any {
		return {
			model: this.getModel().id,
			max_tokens: this.getModel().info.maxTokens,
			system: "(see SYSTEM_PROMPT in src/ClaudeDev.ts)",
			messages: [{ conversation_history: "..." }, { role: "user", content: withoutImageData(userContent) }],
			tools: "(see tools in src/ClaudeDev.ts)",
			tool_choice: "auto",
		}
	}

	getModel(): { id: OpenRouterModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in openRouterModels) {
			const id = modelId as OpenRouterModelId
			return { id, info: openRouterModels[id] }
		}
		return { id: openRouterDefaultModelId, info: openRouterModels[openRouterDefaultModelId] }
	}
}
