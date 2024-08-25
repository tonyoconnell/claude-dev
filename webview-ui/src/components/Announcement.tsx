import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

interface AnnouncementProps {
	version: string
	hideAnnouncement: () => void
}
/*
You must update the latestAnnouncementId in ClaudeDevProvider for new announcements to show to users. This new id will be compared with whats in state for the 'last announcement shown', and if it's different then the announcement will render. As soon as an announcement is shown, the id will be updated in state. This ensures that announcements are not shown more than once, even if the user doesn't close it themselves.
*/
const Announcement = ({ version, hideAnnouncement }: AnnouncementProps) => {
	return (
		<div
			style={{
				backgroundColor: "var(--vscode-editor-inactiveSelectionBackground)",
				borderRadius: "3px",
				padding: "12px 16px",
				margin: "5px 15px 5px 15px",
				position: "relative",
			}}>
			<VSCodeButton
				appearance="icon"
				onClick={hideAnnouncement}
				style={{ position: "absolute", top: "8px", right: "8px" }}>
				<span className="codicon codicon-close"></span>
			</VSCodeButton>
			<h3 style={{ margin: "0 0 8px" }}>
				🎉{"  "}New in v{version}
			</h3>
			<ul style={{ margin: "0 0 8px", paddingLeft: "20px" }}>
				<li>Task history is here! New tasks will automatically save so you can always resume them later</li>
				<li>
					Open in the editor (using{" "}
					<span
						className="codicon codicon-link-external"
						style={{ display: "inline", fontSize: "12.5px", verticalAlign: "text-bottom" }}></span>{" "}
					or <code>ONE: Open In New Tab</code> in command palette) to see how Claude updates your
					workspace more clearly
				</li>
				<li>
					New <code style={{ wordBreak: "break-all" }}>list_files_recursive</code> and{" "}
					<code style={{ wordBreak: "break-all" }}>view_source_code_definitions_top_level</code> tools to help
					Claude get a comprehensive overview of your project's file structure and source code definitions
					</li>
				<li>
					Add support for Prompt Caching to significantly reduce costs and response times (currently only available through Anthropic API for Claude 3.5 Sonnet and Claude 3.0 Haiku)

				</li>
			</ul>
			<p style={{ margin: "0" }}>
				Follow me for more updates!{" "}
				<VSCodeLink href="https://x.com/tonyoconnell" style={{ display: "inline" }}>
					@tonyoconnell
				</VSCodeLink>
			</p>
		</div>
	)
}

export default Announcement
