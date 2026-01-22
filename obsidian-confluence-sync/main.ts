import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from 'obsidian';

interface ConfluenceSyncSettings {
  domain: string;
  username: string;
  apiToken: string;
  spaceId: string;
  attachmentsFolder: string;
  addConfluenceUrl: boolean;
}

interface ConfluencePage {
  id: string;
  title: string;
  type: string;
  version: {
    number: number;
  };
  ancestors?: ConfluencePage[];
}

const DEFAULT_SETTINGS: ConfluenceSyncSettings = {
  domain: '',
  username: '',
  apiToken: '',
  spaceId: '',
  attachmentsFolder: 'attachments',
  addConfluenceUrl: true,
};

export default class ConfluenceSyncPlugin extends Plugin {
  settings: ConfluenceSyncSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'sync-to-confluence',
      name: 'Sync current file to Confluence',
      callback: () => this.syncCurrentFile(),
    });

    this.addSettingTab(new ConfluenceSyncSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async syncCurrentFile() {
    const activeFile = this.app.workspace.getActiveFile();

    if (!activeFile) {
      new Notice('No active file to sync');
      return;
    }

    if (!this.validateSettings()) {
      new Notice('Please configure Confluence settings first');
      return;
    }

    try {
      new Notice('Syncing to Confluence...');
      const content = await this.app.vault.read(activeFile);
      const title = activeFile.basename;
      const folderPath = this.getFolderPath(activeFile);

      // Parse frontmatter to separate it from the body content
      const { body } = this.parseFrontmatter(content);

      // Ensure we have content to upload
      const contentToUpload = body.trim() || '<p>Empty document</p>';

      // Upload to Confluence (only the body, not frontmatter)
      const page = await this.uploadToConfluence(
        title,
        contentToUpload,
        folderPath,
      );

      // If setting is enabled, add Confluence URL to frontmatter
      if (this.settings.addConfluenceUrl) {
        const domain = this.settings.domain.replace(/\/$/, '');
        const confluenceUrl = `${domain}/wiki/spaces/${this.settings.spaceId}/pages/${page.id}`;
        const updatedContent = this.updateFrontmatter(content, confluenceUrl);
        await this.app.vault.modify(activeFile, updatedContent);
      }

      new Notice('Successfully synced to Confluence!');
    } catch (error) {
      console.error('Error syncing to Confluence:', error);
      new Notice(`Failed to sync: ${error.message}`);
    }
  }

  getFolderPath(file: TFile): string[] {
    const parts = file.parent?.path.split('/').filter((p) => p) || [];
    return parts;
  }

  validateSettings(): boolean {
    return !!(
      this.settings.domain &&
      this.settings.username &&
      this.settings.apiToken &&
      this.settings.spaceId
    );
  }

  parseFrontmatter(content: string): {
    frontmatter: Map<string, string>;
    body: string;
    hasFrontmatter: boolean;
  } {
    // const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const frontmatterRegex =
      /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return { frontmatter: new Map(), body: content, hasFrontmatter: false };
    }

    const frontmatterText = match[1];
    const body = match[2];
    const frontmatter = new Map<string, string>();

    // Parse YAML frontmatter (simple key: value pairs)
    const lines = frontmatterText.split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        frontmatter.set(key, value);
      }
    }

    return { frontmatter, body, hasFrontmatter: true };
  }

  updateFrontmatter(content: string, confluenceUrl: string): string {
    const frontmatterRegex =
      /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      // No frontmatter exists, create it
      return `---\nconfluence: ${confluenceUrl}\n---\n${content}`;
    }

    const frontmatterText = match[1];
    const body = match[2];

    // Check if confluence field already exists
    const confluenceLineRegex = /^confluence:.*$/m;
    let updatedFrontmatter: string;

    if (confluenceLineRegex.test(frontmatterText)) {
      // Update existing confluence field
      updatedFrontmatter = frontmatterText.replace(
        confluenceLineRegex,
        `confluence: ${confluenceUrl}`,
      );
    } else {
      // Add confluence field at the end
      updatedFrontmatter = frontmatterText.trimEnd() + `\nconfluence: ${confluenceUrl}`;
    }

    return `---\n${updatedFrontmatter}\n---\n${body}`;
  }

  async uploadToConfluence(
    title: string,
    markdownContent: string,
    folderPath: string[],
  ): Promise<ConfluencePage> {
    const auth = Buffer.from(
      `${this.settings.username}:${this.settings.apiToken}`,
    ).toString('base64');

    const domain = this.settings.domain.replace(/\/$/, '');

    // Extract mermaid blocks and replace with placeholders
    const mermaidBlocks: { id: string; filename: string; code: string }[] = [];
    let processedMarkdown = markdownContent.replace(
      /```mermaid\n([\s\S]+?)```/g,
      (_match, code) => {
        const filename = `MERMAID-PLACEHOLDER-${mermaidBlocks.length}.svg`;
        mermaidBlocks.push({
          id: `MERMAID-PLACEHOLDER-${mermaidBlocks.length}`,
          filename,
          code: code.trim(),
        });
        return `!${filename}`;
      },
    );

    // Extract image attachments and replace with placeholders
    const imageAttachments: { filename: string; placeholder: string }[] = [];
    processedMarkdown = processedMarkdown.replace(
      /!\[\[([^\]]+\.(png|jpe?g))\]\]/gi,
      (_match, filename) => {
        const placeholder = `IMAGE-ATTACHMENT-${imageAttachments.length}`;
        imageAttachments.push({ filename: filename.trim(), placeholder });
        return placeholder;
      },
    );

    const confluenceContent =
      this.convertMarkdownToConfluence(processedMarkdown);

    let parentId: string | null = null;

    if (folderPath.length > 0) {
      new Notice(`Creating folder structure: ${folderPath.join(' > ')}`);
      parentId = await this.ensureFolderHierarchy(folderPath, auth, domain);
    }

    const existingPage = await this.findExistingPage(
      title,
      auth,
      domain,
      parentId,
    );

    let page: ConfluencePage;
    if (existingPage) {
      page = await this.updatePage(
        existingPage.id,
        title,
        confluenceContent,
        existingPage.version.number,
        auth,
        domain,
        parentId,
      );
    } else {
      page = await this.createPage(
        title,
        confluenceContent,
        auth,
        domain,
        parentId,
      );
    }

    // If there are mermaid blocks or image attachments, process them
    if (mermaidBlocks.length > 0 || imageAttachments.length > 0) {
      let updatedContent = confluenceContent;

      // Process mermaid blocks
      if (mermaidBlocks.length > 0) {
        new Notice(`Processing ${mermaidBlocks.length} Mermaid diagram(s)...`);

        for (const block of mermaidBlocks) {
          try {
            // Convert mermaid to SVG
            const svgData = await this.convertMermaidToSvg(block.code);

            // Upload as attachment
            await this.uploadAttachment(
              page.id,
              block.filename,
              svgData,
              auth,
              domain,
            );

            // Replace placeholder with attachment reference (handle potential <p> tags)
            const attachmentMacro = `<ac:image ac:width="500"><ri:attachment ri:filename="${block.filename}" /></ac:image>`;
            const placeholderPattern = new RegExp(
              `(<p>)?!${block.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(</p>)?`,
              'g',
            );
            updatedContent = updatedContent.replace(
              placeholderPattern,
              attachmentMacro,
            );
          } catch (error) {
            console.error(`Error processing mermaid block ${block.id}:`, error);
            new Notice(
              `Warning: Failed to process Mermaid diagram: ${error.message}`,
            );
            // Keep the placeholder if conversion fails
          }
        }
      }

      // Process image attachments
      if (imageAttachments.length > 0) {
        new Notice(
          `Processing ${imageAttachments.length} image attachment(s)...`,
        );

        for (const attachment of imageAttachments) {
          try {
            // Read image file from attachments folder
            const { data, contentType } = await this.readImageAttachment(
              attachment.filename,
            );

            // Upload as attachment
            await this.uploadBinaryAttachment(
              page.id,
              attachment.filename,
              data,
              contentType,
              auth,
              domain,
            );

            // Replace placeholder with attachment reference (handle potential <p> tags)
            const attachmentMacro = `<ac:image ac:width="500"><ri:attachment ri:filename="${attachment.filename}" /></ac:image>`;
            const placeholderPattern = new RegExp(
              `(<p>)?${attachment.placeholder}(</p>)?`,
              'g',
            );
            updatedContent = updatedContent.replace(
              placeholderPattern,
              attachmentMacro,
            );
          } catch (error) {
            console.error(
              `Error processing image attachment ${attachment.filename}:`,
              error,
            );
            new Notice(
              `Warning: Failed to process image ${attachment.filename}: ${error.message}`,
            );
            // Keep the placeholder if processing fails
          }
        }
      }

      // Update the page with the final content including attachment references
      await this.updatePage(
        page.id,
        title,
        updatedContent,
        page.version.number,
        auth,
        domain,
        parentId,
      );
    }

    return page;
  }

  async ensureFolderHierarchy(
    folderPath: string[],
    auth: string,
    domain: string,
  ): Promise<string | null> {
    let currentParentId: string | null = null;

    for (const folderName of folderPath) {
      let existingPage: ConfluencePage | null = await this.findExistingPage(
        folderName,
        auth,
        domain,
        currentParentId,
      );

      if (existingPage) {
        // Found page with correct parent
        currentParentId = existingPage.id;
      } else {
        // Check if page exists anywhere in the space (wrong parent or at root)
        const anyPage: ConfluencePage | null = await this.findExistingPage(
          folderName,
          auth,
          domain,
          null,
        );

        if (anyPage) {
          // Page exists but in wrong location - update its parent
          new Notice(`Moving "${folderName}" to correct location...`);
          const updatedPage: ConfluencePage = await this.updatePage(
            anyPage.id,
            folderName,
            '<p>This page represents a folder in your Obsidian vault.</p>',
            anyPage.version.number,
            auth,
            domain,
            currentParentId,
          );
          currentParentId = updatedPage.id;
        } else {
          // Check if an archived page exists with this title
          const archivedPage: ConfluencePage | null =
            await this.findArchivedPage(folderName, auth, domain);

          if (archivedPage) {
            // Archived page found - can't create or restore automatically
            const domain = this.settings.domain.replace(/\/$/, '');
            const pageUrl = `${domain}/wiki/spaces/${this.settings.spaceId}/pages/${archivedPage.id}`;
            const errorMsg = `Cannot create page "${folderName}" - an archived page with this title exists. Please permanently delete it from Confluence trash first: ${pageUrl}`;
            console.error(errorMsg);
            new Notice(errorMsg, 10000);
            throw new Error(errorMsg);
          } else {
            // Page doesn't exist at all - create it
            const newPage: ConfluencePage = await this.createPage(
              folderName,
              '<p>This page represents a folder in your Obsidian vault.</p>',
              auth,
              domain,
              currentParentId,
            );
            currentParentId = newPage.id;
          }
        }
      }
    }

    return currentParentId;
  }

  async findExistingPage(
    title: string,
    auth: string,
    domain: string,
    parentId: string | null = null,
  ): Promise<ConfluencePage | null> {
    let searchUrl = `${domain}/wiki/rest/api/content?spaceKey=${this.settings.spaceId}&title=${encodeURIComponent(title)}&status=current&expand=version,ancestors`;

    const response = await requestUrl({
      url: searchUrl,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to search for page: ${response.status}`);
    }

    const data = response.json;

    if (!data.results || data.results.length === 0) {
      return null;
    }

    // Filter out archived pages (extra safety check)
    const activePages = data.results.filter(
      (page: any) => page.status !== 'archived',
    );

    if (activePages.length === 0) {
      return null;
    }

    if (parentId === null) {
      return activePages[0];
    }

    // Look for a page whose immediate parent matches the parentId
    for (const page of activePages) {
      const ancestors: ConfluencePage[] = page.ancestors || [];

      // Check if the immediate parent (last ancestor) matches
      if (ancestors.length > 0) {
        const immediateParent = ancestors[ancestors.length - 1];
        if (immediateParent.id === parentId) {
          return page;
        }
      }
    }

    return null;
  }

  async findArchivedPage(
    title: string,
    auth: string,
    domain: string,
  ): Promise<ConfluencePage | null> {
    let searchUrl = `${domain}/wiki/rest/api/content?spaceKey=${this.settings.spaceId}&title=${encodeURIComponent(title)}&status=archived&expand=version`;

    const response = await requestUrl({
      url: searchUrl,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status !== 200) {
      return null;
    }

    const data = response.json;

    if (!data.results || data.results.length === 0) {
      return null;
    }

    return data.results[0];
  }

  async getPageAncestors(
    pageId: string,
    auth: string,
    domain: string,
  ): Promise<ConfluencePage[]> {
    const url = `${domain}/wiki/rest/api/content/${pageId}?expand=ancestors`;

    const response = await requestUrl({
      url: url,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status !== 200) {
      return [];
    }

    const data = response.json;
    return data.ancestors || [];
  }

  async createPage(
    title: string,
    content: string,
    auth: string,
    domain: string,
    parentId: string | null = null,
  ): Promise<ConfluencePage> {
    const url = `${domain}/wiki/rest/api/content`;

    const body: any = {
      type: 'page',
      title: title,
      space: {
        key: this.settings.spaceId,
      },
      body: {
        storage: {
          value: content,
          representation: 'storage',
        },
      },
    };

    if (parentId) {
      body.ancestors = [{ id: parentId }];
    }

    try {
      const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        throw: false, // Don't throw on non-2xx status
      });

      if (response.status !== 200 && response.status !== 201) {
        const errorDetail = response.json?.message || response.text;
        throw new Error(
          `Failed to create page "${title}": ${response.status} - ${errorDetail}`,
        );
      }

      return response.json;
    } catch (error) {
      throw new Error(`Failed to create page "${title}": ${error.message}`);
    }
  }

  async updatePage(
    pageId: string,
    title: string,
    content: string,
    currentVersion: number,
    auth: string,
    domain: string,
    parentId: string | null = null,
  ): Promise<ConfluencePage> {
    const url = `${domain}/wiki/rest/api/content/${pageId}`;

    const body: any = {
      version: {
        number: currentVersion + 1,
      },
      title: title,
      type: 'page',
      body: {
        storage: {
          value: content,
          representation: 'storage',
        },
      },
    };

    if (parentId) {
      body.ancestors = [{ id: parentId }];
    }

    try {
      const response = await requestUrl({
        url: url,
        method: 'PUT',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.status !== 200) {
        const errorDetail = response.json?.message || response.text;
        throw new Error(
          `Failed to update page "${title}": ${response.status} - ${errorDetail}`,
        );
      }

      return response.json;
    } catch (error) {
      throw new Error(`Failed to update page "${title}": ${error.message}`);
    }
  }

  async convertMermaidToSvg(mermaidCode: string): Promise<ArrayBuffer> {
    const url = `https://kroki.io/mermaid/svg`;

    try {
      const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: mermaidCode,
      });

      if (response.status !== 200) {
        throw new Error(`Kroki returned status ${response.status}`);
      }

      return response.arrayBuffer;
    } catch (error) {
      throw new Error(`Failed to convert Mermaid to SVG: ${error.message}`);
    }
  }

  createMultipartBody(
    boundary: string,
    filename: string,
    fileContent: string,
  ): ArrayBuffer {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    // Add boundary and headers
    const header = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: image/svg+xml',
      '',
      '',
    ].join('\r\n');

    parts.push(encoder.encode(header));
    parts.push(encoder.encode(fileContent));
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

    // Calculate total length
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);

    // Combine all parts
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }

    return result.buffer;
  }

  async uploadAttachment(
    pageId: string,
    filename: string,
    data: ArrayBuffer,
    auth: string,
    domain: string,
  ): Promise<string> {
    // Use PUT to create or update attachment (upsert)
    const url = `${domain}/wiki/rest/api/content/${pageId}/child/attachment`;

    // Create multipart form data
    const boundary =
      '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const svgContent = new TextDecoder().decode(data);
    const body = this.createMultipartBody(boundary, filename, svgContent);

    const response = await requestUrl({
      url: url,
      method: 'PUT',
      headers: {
        Authorization: `Basic ${auth}`,
        'X-Atlassian-Token': 'nocheck',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (response.status !== 200) {
      throw new Error(
        `Failed to upload attachment: ${response.status} - ${response.text}`,
      );
    }

    const data_response = response.json;
    return data_response.results[0].id;
  }

  async readImageAttachment(
    filename: string,
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    const attachmentPath = `${this.settings.attachmentsFolder}/${filename}`;

    try {
      const file = this.app.vault.getAbstractFileByPath(attachmentPath);

      if (!file || !(file instanceof TFile)) {
        throw new Error(`File not found: ${attachmentPath}`);
      }

      const data = await this.app.vault.readBinary(file);

      // Determine content type based on file extension
      const extension = filename.toLowerCase().split('.').pop();
      let contentType = 'application/octet-stream';
      if (extension === 'png') contentType = 'image/png';
      else if (extension === 'jpg' || extension === 'jpeg')
        contentType = 'image/jpeg';

      return { data, contentType };
    } catch (error) {
      throw new Error(
        `Failed to read attachment ${filename}: ${error.message}`,
      );
    }
  }

  createMultipartBodyBinary(
    boundary: string,
    filename: string,
    fileData: ArrayBuffer,
    contentType: string,
  ): ArrayBuffer {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    // Add boundary and headers
    const header = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${contentType}`,
      '',
      '',
    ].join('\r\n');

    parts.push(encoder.encode(header));
    parts.push(new Uint8Array(fileData));
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

    // Calculate total length
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);

    // Combine all parts
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }

    return result.buffer;
  }

  async uploadBinaryAttachment(
    pageId: string,
    filename: string,
    data: ArrayBuffer,
    contentType: string,
    auth: string,
    domain: string,
  ): Promise<string> {
    // Use PUT to create or update attachment (upsert)
    const url = `${domain}/wiki/rest/api/content/${pageId}/child/attachment`;

    // Create multipart form data with binary content
    const boundary =
      '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const body = this.createMultipartBodyBinary(
      boundary,
      filename,
      data,
      contentType,
    );

    const response = await requestUrl({
      url: url,
      method: 'PUT',
      headers: {
        Authorization: `Basic ${auth}`,
        'X-Atlassian-Token': 'nocheck',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (response.status !== 200) {
      throw new Error(
        `Failed to upload binary attachment: ${response.status} - ${response.text}`,
      );
    }

    const data_response = response.json;
    return data_response.results[0].id;
  }

  convertMarkdownToConfluence(markdown: string): string {
    let confluence = markdown;

    confluence = this.convertDataviewJsTags(confluence);
    confluence = this.convertWikiLinks(confluence);
    confluence = this.removeInlineIcons(confluence);
    confluence = this.convertHeadings(confluence);
    confluence = this.convertCodeBlocks(confluence);
    confluence = this.convertImages(confluence);
    confluence = this.convertTables(confluence);
    confluence = this.convertTaskLists(confluence);
    confluence = this.convertTextFormatting(confluence);
    confluence = this.convertStrikethrough(confluence);
    confluence = this.convertLinks(confluence);
    confluence = this.convertInlineCode(confluence);
    confluence = this.convertHorizontalRules(confluence);
    confluence = this.convertBlockquotes(confluence);
    confluence = this.convertLists(confluence);
    confluence = this.convertParagraphs(confluence);

    return confluence;
  }

  private convertDataviewJsTags(text: string): string {
    // Convert dataviewjs tag blocks to hashtags
    // Example: ```dataviewjs dv.view('src/dataview/tags', { tags:['TI'], header: '...' })``` -> #TI
    return text.replace(
      /```dataviewjs\s*dv\.view\([^,]+,\s*\{\s*tags:\s*\[([^\]]+)\][^\}]*\}\s*\)\s*```/g,
      (_match, tagsStr) => {
        const tags = tagsStr
          .split(',')
          .map((tag: string) => {
            return tag.trim().replace(/['"]/g, '');
          })
          .filter((tag: string) => tag.length > 0);

        return tags.map((tag: string) => `#${tag}`).join(' ');
      },
    );
  }

  private convertWikiLinks(text: string): string {
    // Convert wiki-style links to Confluence links
    // [[Tech/Tech/Notes]] -> Confluence link to "Notes" page
    // [[Tech/Tech/Notes|Custom Text]] -> Confluence link with custom display text
    return text.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, path, displayText) => {
        const pathParts = path.split('/');
        const pageTitle = pathParts[pathParts.length - 1].trim();
        const linkText = displayText ? displayText.trim() : pageTitle;

        return `<ac:link><ri:page ri:content-title="${pageTitle}" /><ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body></ac:link>`;
      },
    );
  }

  private removeInlineIcons(text: string): string {
    // Remove inline icon images from markdown (e.g., ![icon](attachments/icons/atlassian.png))
    return text.replace(/!\[[^\]]*\]\(attachments\/[^)]+\)/g, '');
  }

  private convertHeadings(text: string): string {
    return text.replace(/^(#+) (.+)$/gm, (_match, hashes, content) => {
      const level = hashes.length;
      return `<h${level}>${content}</h${level}>`;
    });
  }

  private convertCodeBlocks(text: string): string {
    return text.replace(/```(\w*)\n([\s\S]+?)```/g, (_match, lang, code) => {
      const language = lang || 'none';
      return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${language}</ac:parameter><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`;
    });
  }

  private convertImages(text: string): string {
    return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, _alt, url) => {
      return `<ac:image><ri:url ri:value="${url}" /></ac:image>`;
    });
  }

  private convertTables(text: string): string {
    return text.replace(/^((?:\|.+\|[\r\n]+)+)/gm, (match) => {
      const rows = match.trim().split('\n');
      let tableHtml = '<table><tbody>';

      rows.forEach((row, index) => {
        if (index === 1) return; // Skip separator row

        const cells = row.split('|').filter((cell) => cell.trim());
        const tag = index === 0 ? 'th' : 'td';
        tableHtml += '<tr>';
        cells.forEach((cell) => {
          tableHtml += `<${tag}>${cell.trim()}</${tag}>`;
        });
        tableHtml += '</tr>';
      });

      tableHtml += '</tbody></table>';
      return tableHtml + '\n';
    });
  }

  private convertTaskLists(text: string): string {
    return text.replace(/^- \[([ x])\] (.+)$/gm, (_match, checked, content) => {
      const isChecked = checked.toLowerCase() === 'x';
      return `<ac:task><ac:task-status>${isChecked ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${content}</ac:task-body></ac:task>`;
    });
  }

  private convertTextFormatting(text: string): string {
    let result = text;

    // Bold and italic
    result = result.replace(
      /\*\*\*(.+?)\*\*\*/g,
      '<strong><em>$1</em></strong>',
    );
    result = result.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');

    // Bold
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    result = result.replace(/\*(?!\s)(.+?)(?<!\s)\*/g, '<em>$1</em>');
    result = result.replace(/_(?!\s)(.+?)(?<!\s)_/g, '<em>$1</em>');

    return result;
  }

  private convertStrikethrough(text: string): string {
    return text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  }

  private convertLinks(text: string): string {
    return text.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  }

  private convertInlineCode(text: string): string {
    return text.replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  private convertHorizontalRules(text: string): string {
    return text.replace(/^---+$/gm, '<hr/>');
  }

  private convertBlockquotes(text: string): string {
    let result = text.replace(
      /^> (.+)$/gm,
      '<blockquote><p>$1</p></blockquote>',
    );
    result = result.replace(/<\/blockquote>\s*<blockquote>/g, '');
    return result;
  }

  private convertLists(text: string): string {
    const listLines = text.split('\n');
    const processedLines: string[] = [];
    let i = 0;

    while (i < listLines.length) {
      const line = listLines[i];
      const olMatch = line.match(/^(\s*)\d+\. (.+)$/);
      const ulMatch = line.match(/^(\s*)[*-] (.+)$/);

      // Check if this is the start of an ordered list
      if (olMatch && olMatch[1].length === 0) {
        // Start of a root-level ordered list
        const orderedItems: string[] = [];

        while (i < listLines.length) {
          const currentLine = listLines[i];
          const currentOlMatch = currentLine.match(/^(\s*)\d+\. (.+)$/);

          // If this is a root-level ordered list item
          if (currentOlMatch && currentOlMatch[1].length === 0) {
            // Collect the content for this list item (including nested content)
            let itemContent = currentOlMatch[2];
            i++;

            // Collect nested/continuation lines
            while (i < listLines.length) {
              const nextLine = listLines[i];
              const nextOlMatch = nextLine.match(/^(\s*)\d+\. (.+)$/);

              // Stop if we hit another root-level ordered list item
              if (nextOlMatch && nextOlMatch[1].length === 0) {
                break;
              }

              // Stop if we hit a non-empty, non-indented line that's not a list item
              if (nextLine.trim() && !nextLine.match(/^\s+/)) {
                break;
              }

              // Check for nested bullet lists
              const nestedUlMatch = nextLine.match(/^(\s+)[*-] (.+)$/);
              if (nestedUlMatch) {
                // Start collecting nested bullets
                const nestedItems: string[] = [];
                const baseIndent = nestedUlMatch[1].length;

                while (i < listLines.length) {
                  const nestedLine = listLines[i];
                  const nestedMatch = nestedLine.match(/^(\s+)[*-] (.+)$/);

                  if (nestedMatch && nestedMatch[1].length >= baseIndent) {
                    nestedItems.push(`<li>${nestedMatch[2]}</li>`);
                    i++;
                  } else {
                    break;
                  }
                }

                if (nestedItems.length > 0) {
                  itemContent += `<ul>${nestedItems.join('')}</ul>`;
                }
              } else if (nextLine.trim()) {
                // Add other indented content
                itemContent += ` ${nextLine.trim()}`;
                i++;
              } else {
                // Skip empty lines within the list item
                i++;
              }
            }

            orderedItems.push(`<li>${itemContent}</li>`);
          } else {
            break;
          }
        }

        if (orderedItems.length > 0) {
          processedLines.push(`<ol>${orderedItems.join('')}</ol>`);
        }
      }
      // Check if this is the start of an unordered list (root-level)
      else if (ulMatch && ulMatch[1].length === 0) {
        const unorderedItems: string[] = [];

        while (i < listLines.length) {
          const currentLine = listLines[i];
          const currentUlMatch = currentLine.match(/^(\s*)[*-] (.+)$/);

          if (currentUlMatch && currentUlMatch[1].length === 0) {
            unorderedItems.push(`<li>${currentUlMatch[2]}</li>`);
            i++;
          } else {
            break;
          }
        }

        if (unorderedItems.length > 0) {
          processedLines.push(`<ul>${unorderedItems.join('')}</ul>`);
        }
      } else {
        processedLines.push(line);
        i++;
      }
    }

    return processedLines.join('\n');
  }

  private convertParagraphs(text: string): string {
    let result = text;

    // Add paragraph breaks
    result = result.replace(/\n\n+/g, '</p><p>');

    // Add trailing paragraph tags
    const addTrailParagraphs = (input: string) => {
      const parts = input.split(
        /(<ac:structured-macro[\s\S]*?<\/ac:structured-macro>)/g,
      );
      return parts
        .map((part) => {
          if (part.startsWith('<ac:structured-macro')) return part;
          return part.replace(/([^>])$/gm, '$1</p>');
        })
        .join('');
    };
    result = addTrailParagraphs(result);

    // Clean up empty and malformed paragraph tags
    result = result.replace(/<p><\/p>/g, '');
    result = result.replace(
      /<p>(<(?:h\d|ul|ol|table|blockquote|ac:|hr))/g,
      '$1',
    );
    result = result.replace(
      /(<\/(?:h\d|ul|ol|table|blockquote|ac:structured-macro|hr\/)>)<\/p>/g,
      '$1',
    );

    return result;
  }
}

class ConfluenceSyncSettingTab extends PluginSettingTab {
  plugin: ConfluenceSyncPlugin;

  constructor(app: App, plugin: ConfluenceSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Confluence Sync Settings' });

    new Setting(containerEl)
      .setName('Confluence Domain')
      .setDesc(
        'Your Confluence domain (e.g., https://yourcompany.atlassian.net)',
      )
      .addText((text) =>
        text
          .setPlaceholder('https://yourcompany.atlassian.net')
          .setValue(this.plugin.settings.domain)
          .onChange(async (value) => {
            this.plugin.settings.domain = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Username')
      .setDesc('Your Confluence username (email)')
      .addText((text) =>
        text
          .setPlaceholder('user@example.com')
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('API Token')
      .setDesc('Your Confluence API token')
      .addText((text) => {
        text
          .setPlaceholder('Enter API token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Space ID')
      .setDesc('The Confluence space key where pages will be created')
      .addText((text) =>
        text
          .setPlaceholder('SPACE')
          .setValue(this.plugin.settings.spaceId)
          .onChange(async (value) => {
            this.plugin.settings.spaceId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Attachments Folder')
      .setDesc(
        'Folder path relative to vault root where attachments are stored (e.g., attachments)',
      )
      .addText((text) =>
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.attachmentsFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentsFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Add Confluence URL to frontmatter')
      .setDesc(
        'Automatically add the Confluence page URL to the file frontmatter after syncing',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.addConfluenceUrl)
          .onChange(async (value) => {
            this.plugin.settings.addConfluenceUrl = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
