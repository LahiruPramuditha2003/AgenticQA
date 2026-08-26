import * as vscode from 'vscode';

export interface ChatMessage {
  role: 'user' | 'assistant';
  type?: 'domain_qa' | 'casual';
  question?: string;
  answer?: {
    directAnswer: string;
    detailedExplanation: string;
    sources: Array<{
      title: string;
      url: string;
      type: string;
      contribution?: string;
    }>;
    confidence: string;
    confidenceReasoning: string;
    isComplete: boolean;
    missingInformation?: string;
    warnings?: string[];
  };
  text?: string;
  timestamp?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private messages: ChatMessage[] = [];
  private webviewView: vscode.WebviewView | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'submitPrompt': {
          if (data.text) {
            this.addMessage({ role: 'user', text: data.text });
            vscode.commands.executeCommand('agenticqa.newRequest', data.text);
          }
          break;
        }
        case 'clearMessages': {
          this.messages = [];
          this.updateWebview();
          break;
        }
      }
    });
  }

  public addMessage(message: ChatMessage) {
    this.messages.push({
      ...message,
      timestamp: new Date().toISOString()
    });
    this.updateWebview();
  }

  private updateWebview() {
    if (this.webviewView) {
      this.webviewView.webview.html = this._getHtmlForWebview();
      setTimeout(() => {
        this.webviewView?.webview.postMessage({ type: 'scrollToBottom' });
      }, 100);
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private formatMarkdown(text: string): string {
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="$1">$2</code></pre>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/\n/g, '<br>');
    return text;
  }

  private renderSources(sources: Array<{title: string; url: string; type: string; contribution?: string}>): string {
    if (!sources || sources.length === 0) {
      return '<div class="no-sources">No source citations</div>';
    }

    return sources.map(s => `
      <div class="source-item">
        <div class="source-header">
          <span class="source-type">${s.type === 'primary' ? '📖' : '📄'}</span>
          <span class="source-title">${this.escapeHtml(s.title)}</span>
        </div>
        <a href="${this.escapeHtml(s.url)}" target="_blank" class="source-url">${this.escapeHtml(s.url)}</a>
        ${s.contribution ? `<div class="source-contribution">${this.escapeHtml(s.contribution)}</div>` : ''}
      </div>
    `).join('');
  }

  private renderMessage(msg: ChatMessage): string {
    if (msg.role === 'user') {
      return `
        <div class="message user-message">
          <div class="message-content">${this.escapeHtml(msg.text || '')}</div>
        </div>
      `;
    }

    if (msg.type === 'casual' || !msg.answer) {
      return `
        <div class="message assistant-message casual-message">
          <div class="message-header">
            <span class="assistant-label">AgenticQA</span>
            <span class="type-badge casual">Assistant</span>
          </div>
          <div class="message-content">${this.formatMarkdown(this.escapeHtml(msg.text || ''))}</div>
        </div>
      `;
    }

    const a = msg.answer;
    const confidenceClass = a.confidence.toLowerCase();

    return `
      <div class="message assistant-message domain-message">
        <div class="message-header">
          <span class="assistant-label">AgenticQA</span>
          <span class="type-badge domain">Domain Q&A</span>
          <span class="confidence-badge ${confidenceClass}">${a.confidence}</span>
        </div>
        ${a.directAnswer ? `
          <div class="direct-answer">
            <div class="section-label">Answer</div>
            <div class="answer-text">${this.formatMarkdown(this.escapeHtml(a.directAnswer))}</div>
          </div>
        ` : ''}
        ${a.detailedExplanation ? `
          <div class="detailed-explanation">
            <div class="section-label">Details</div>
            <div class="explanation-text">${this.formatMarkdown(this.escapeHtml(a.detailedExplanation))}</div>
          </div>
        ` : ''}
        ${a.sources && a.sources.length > 0 ? `
          <div class="sources-section">
            <div class="section-label">Sources</div>
            ${this.renderSources(a.sources)}
          </div>
        ` : ''}
        ${a.isComplete === false && a.missingInformation ? `
          <div class="missing-info">
            <span class="warning-icon">⚠️</span> Missing: ${this.escapeHtml(a.missingInformation)}
          </div>
        ` : ''}
        ${a.warnings && a.warnings.length > 0 ? `
          <div class="warnings">
            ${a.warnings.map(w => `<div class="warning">⚠️ ${this.escapeHtml(w)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  private _getHtmlForWebview() {
    const messagesHtml = this.messages.map(m => this.renderMessage(m)).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgenticQA</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      max-width: 95%;
      padding: 12px 14px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    .user-message {
      align-self: flex-end;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 4px;
    }
    .assistant-message {
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .casual-message {
      background-color: #1a1a2e;
      color: #e4e4e7;
      border: 1px solid #3a3a5c;
    }
    .domain-message {
      background-color: #1a1a2e;
      color: #e4e4e7;
      border: 1px solid #3a3a5c;
    }
    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.15);
    }
    .assistant-label {
      font-weight: 600;
      font-size: 12px;
      opacity: 0.95;
    }
    .type-badge {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 8px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .type-badge.domain {
      background-color: #6366f1;
      color: white;
    }
    .type-badge.casual {
      background-color: #10b981;
      color: white;
    }
    .confidence-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
      margin-left: auto;
    }
    .confidence-badge.high {
      background-color: #22c55e;
      color: #000;
    }
    .confidence-badge.medium {
      background-color: #f59e0b;
      color: #000;
    }
    .confidence-badge.low {
      background-color: #ef4444;
      color: white;
    }
    .confidence-badge.unknown {
      background-color: #6b7280;
      color: white;
    }
    .direct-answer, .detailed-explanation, .sources-section {
      margin-bottom: 12px;
    }
    .section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
      margin-bottom: 4px;
      font-weight: 600;
      color: #a1a1aa;
    }
    .answer-text {
      font-size: 13px;
      line-height: 1.6;
    }
    .explanation-text {
      font-size: 12px;
      opacity: 0.85;
      line-height: 1.6;
    }
    code {
      background-color: rgba(255,255,255,0.1);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    pre {
      background-color: rgba(0,0,0,0.3);
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
    }
    pre code {
      background: none;
      padding: 0;
    }
    .sources-section {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .source-item {
      margin-bottom: 10px;
      padding: 8px 10px;
      background-color: rgba(255,255,255,0.05);
      border-radius: 6px;
      font-size: 11px;
      border-left: 3px solid #6366f1;
    }
    .source-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    .source-type {
      font-size: 12px;
    }
    .source-title {
      font-weight: 500;
      color: #e4e4e7;
    }
    .source-url {
      display: block;
      font-size: 10px;
      color: #818cf8;
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source-url:hover {
      text-decoration: underline;
    }
    .source-contribution {
      margin-top: 4px;
      font-size: 10px;
      opacity: 0.7;
      font-style: italic;
      color: #a1a1aa;
    }
    .no-sources {
      font-size: 11px;
      opacity: 0.5;
      font-style: italic;
    }
    .missing-info, .warnings {
      margin-top: 10px;
      font-size: 11px;
      padding: 8px 10px;
      background-color: rgba(239, 68, 68, 0.2);
      border-radius: 6px;
      border-left: 3px solid #ef4444;
    }
    .warning {
      margin-top: 4px;
    }
    .input-area {
      padding: 10px;
      border-top: 1px solid var(--vscode-widget-border);
      background-color: var(--vscode-editor-background);
    }
    textarea {
      width: 100%;
      min-height: 60px;
      resize: vertical;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      margin-bottom: 8px;
    }
    textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .button-row {
      display: flex;
      gap: 8px;
    }
    button {
      flex: 1;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 10px 12px;
      font-size: 13px;
      cursor: pointer;
      border-radius: 6px;
      font-weight: 500;
    }
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background-color: transparent;
      border: 1px solid var(--vscode-button-secondaryBackground, #3c3c3c);
    }
    .helper-text {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 8px;
      text-align: center;
    }
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      opacity: 0.6;
      padding: 20px;
      text-align: center;
    }
    .empty-state-icon {
      font-size: 36px;
      margin-bottom: 10px;
    }
    .empty-state-text {
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="messages-container" id="messages-container">
    ${this.messages.length === 0 ? `
      <div class="empty-state">
        <div class="empty-state-icon">🤖</div>
        <div class="empty-state-text">Ask me anything about your project's documentation or how to test your app!</div>
      </div>
    ` : messagesHtml}
  </div>
  <div class="input-area">
    <textarea id="prompt-input" placeholder="Ask a question or describe a test... (Ctrl+Enter to send)"></textarea>
    <div class="button-row">
      <button id="submit-btn">Run AgenticQA</button>
      <button id="clear-btn" class="secondary">Clear</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const promptInput = document.getElementById('prompt-input');
    const submitBtn = document.getElementById('submit-btn');
    const clearBtn = document.getElementById('clear-btn');
    const messagesContainer = document.getElementById('messages-container');

    function submitCommand() {
      const text = promptInput.value.trim();
      if (text) {
        vscode.postMessage({ type: 'submitPrompt', text: text });
        promptInput.value = '';
      }
    }

    submitBtn.addEventListener('click', submitCommand);
    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearMessages' });
    });

    promptInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitCommand();
      }
    });

    window.addEventListener('message', (event) => {
      if (event.data.type === 'scrollToBottom') {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    });

    window.addEventListener('load', () => {
      promptInput.focus();
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  </script>
</body>
</html>`;
  }
}