import { Plugin, TFile, Menu, MarkdownRenderer } from "obsidian";
import { shell } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export default class OpenMarkdownAsHtmlPlugin extends Plugin {
	onload() {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TFile) => {
				if (file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("Open in Browser")
							.setIcon("globe")
							.onClick(() => this.openRenderedMarkdown(file))
					);
				}
			})
		);
	}

	async openRenderedMarkdown(file: TFile) {
		const markdown = await this.app.vault.read(file);
		const htmlBody = await this.renderMarkdownToHtml(markdown, file.path);

		const fullHtml = `
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<title>${file.basename}</title>
				<style>
					body {
						font-family: -apple-system, BlinkMacSystemFont, sans-serif;
						margin: 40px;
						max-width: 800px;
					}
					pre, code {
						background-color: #f0f0f0;
						padding: 0.2em 0.4em;
						border-radius: 4px;
					}
				</style>
			</head>
			<body>
				${htmlBody}
			</body>
			</html>
		`;

		const tempPath = path.join(os.tmpdir(), `${file.basename}.html`);
		fs.writeFileSync(tempPath, fullHtml, "utf8");

		shell.openExternal(`file://${tempPath}`);
	}

	async renderMarkdownToHtml(markdown: string, sourcePath: string): Promise<string> {
		const el = document.createElement("div");
		await MarkdownRenderer.render(
			this.app,
			markdown,
			el,
			sourcePath,
			this
		);
		return el.innerHTML;
	}
}
