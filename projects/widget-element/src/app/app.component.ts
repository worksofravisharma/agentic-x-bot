import { Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild } from '@angular/core';

type FileUploadState = 'uploading' | 'done' | 'error';

type FileUploadMeta = {
  fileName: string;
  progress: number;
  state: FileUploadState;
  /** From `FileReader.readAsDataURL`: `data:<mime>;base64,<payload>` */
  dataUrl?: string;
  /** Parsed MIME, e.g. `application/pdf` */
  mimeType?: string;
  /** Base64 payload only (no `data:...;base64,` prefix) */
  base64Payload?: string;
};

type ChatMessage = {
  content: string;
  isUser: boolean;
  feedback?: 'up' | 'down';
  /** When set, bubble shows file card + upload progress instead of plain text. */
  fileUpload?: FileUploadMeta;
  /** When set, bubble uses link-card layout (distinct from plain text). */
  linkUrl?: string;
  /** Optional label shown above the URL (e.g. page title). */
  linkTitle?: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLite) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionResultLite = {
  0: { transcript?: string };
  isFinal?: boolean;
};

type SpeechRecognitionEventLite = {
  resultIndex: number;
  results: SpeechRecognitionResultLite[];
};

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnDestroy {
  isChatOpen = false;
  isDarkTheme = false;
  isTyping = false;
  isToolsOpen = false;
  /** Fixed position of the launcher + chat panel: `right` (default) or `left`. */
  chatDockSide: 'left' | 'right' = 'right';
  /** Which bot message index has the ⋮ actions menu open (null = closed). */
  openBubbleMenuIndex: number | null = null;
  isListening = false;
  voiceInputSupported = false;
  messageInput = '';
  private botReplyTimer?: ReturnType<typeof setTimeout>;
  private uploadProgressTimers: ReturnType<typeof setTimeout>[] = [];
  /** Reject reads above this size (base64 ~33% larger in memory). */
  private readonly maxUploadBytes = 20 * 1024 * 1024;
  private speechRecognition?: BrowserSpeechRecognition;
  /** Finalized speech for the current mic session; applied to the input on stop. */
  private speechSessionAccumulated = '';
  messages: ChatMessage[] = [
    {
      content:
        "Hello! I'm Bizzy, your AI payroll & tax agent. Upload a payslip to simulate tax scenarios or decode your deductions. How can I help you optimize your take-home pay today?",
      isUser: false
    }
  ];

  @ViewChild('chatContainer') chatContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('fileInputEl') fileInputEl?: ElementRef<HTMLInputElement>;

  constructor(private ngZone: NgZone) {
    this.voiceInputSupported = this.ensureSpeechRecognition();
  }

  toggleChat(): void {
    this.isChatOpen = !this.isChatOpen;
    if (!this.isChatOpen) {
      this.isToolsOpen = false;
      this.openBubbleMenuIndex = null;
    }
    setTimeout(() => this.scrollToBottom(), 0);
  }

  closeChat(): void {
    this.isChatOpen = false;
    this.isToolsOpen = false;
    this.openBubbleMenuIndex = null;
  }

  toggleTheme(): void {
    this.isDarkTheme = !this.isDarkTheme;
  }

  clearInput(): void {
    this.messageInput = '';
  }

  openTools(): void {
    this.isToolsOpen = !this.isToolsOpen;
  }

  toggleChatDockSide(): void {
    this.chatDockSide = this.chatDockSide === 'right' ? 'left' : 'right';
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const el = event.target as HTMLElement | null;
    if (!el) {
      return;
    }

    const inBubbleMenu = el.closest('.bubble-menu');
    const inTools = el.closest('.tools-panel') || el.closest('.tools-menu-trigger');

    if (!inBubbleMenu) {
      this.openBubbleMenuIndex = null;
    }
    if (!inTools) {
      this.isToolsOpen = false;
    }
  }

  toggleBubbleMenu(index: number, event: MouseEvent): void {
    event.stopPropagation();
    this.openBubbleMenuIndex = this.openBubbleMenuIndex === index ? null : index;
  }

  closeBubbleMenu(): void {
    this.openBubbleMenuIndex = null;
  }

  setBotFeedback(index: number, value: 'up' | 'down'): void {
    const msg = this.messages[index];
    if (!msg || msg.isUser) {
      return;
    }
    msg.feedback = msg.feedback === value ? undefined : value;
    this.closeBubbleMenu();
  }

  async copyBotMessageFromMenu(message: ChatMessage): Promise<void> {
    await this.copyBotMessage(message);
    this.closeBubbleMenu();
  }

  triggerFileUpload(): void {
    this.fileInputEl?.nativeElement.click();
  }

  handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    if (!this.isAllowedUploadFile(file)) {
      this.addMessage('Only PDF, images, CSV, and Excel (.xls, .xlsx) files are allowed.');
      input.value = '';
      return;
    }
    if (file.size > this.maxUploadBytes) {
      this.addMessage(`File is too large. Maximum size is ${this.maxUploadBytes / (1024 * 1024)} MB.`);
      input.value = '';
      return;
    }
    this.addFileUploadMessage(file);
    input.value = '';
  }

  /** Font Awesome class for the file row (by extension). */
  fileUploadIconClass(message: ChatMessage): string {
    const name = message.fileUpload?.fileName ?? '';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') {
      return 'fa-file-pdf';
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
      return 'fa-file-image';
    }
    if (ext === 'csv') {
      return 'fa-file-csv';
    }
    if (ext === 'xls' || ext === 'xlsx') {
      return 'fa-file-excel';
    }
    return 'fa-file';
  }

  /** CSS modifier for icon tint (`file-upload-bubble--pdf`, etc.). */
  fileUploadKind(message: ChatMessage): 'pdf' | 'image' | 'csv' | 'excel' | 'file' {
    const name = message.fileUpload?.fileName ?? '';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') {
      return 'pdf';
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
      return 'image';
    }
    if (ext === 'csv') {
      return 'csv';
    }
    if (ext === 'xls' || ext === 'xlsx') {
      return 'excel';
    }
    return 'file';
  }

  private addFileUploadMessage(file: File): void {
    const msg: ChatMessage = {
      content: '',
      isUser: true,
      fileUpload: {
        fileName: file.name,
        progress: 0,
        state: 'uploading'
      }
    };
    this.messages.push(msg);
    const index = this.messages.length - 1;
    this.scrollToBottom();
    this.runUploadProgressSimulation(index);
    this.encodeFileToBase64(file, index);
  }

  /**
   * Reads file as a data URL (`data:<mime>;base64,...`) and attaches parsed fields to the message.
   * Call your API with `mimeType`, `base64Payload`, and `fileName` when `state === 'done'`.
   */
  private encodeFileToBase64(file: File, messageIndex: number): void {
    this.convertFileToDataUrl(file)
      .then((dataUrl) => {
        this.ngZone.run(() => {
          this.clearUploadProgressTimers();
          const msg = this.messages[messageIndex];
          if (!msg?.fileUpload || msg.fileUpload.state === 'error') {
            return;
          }
          const { mimeType, base64Payload } = AppComponent.parseDataUrl(dataUrl);
          console.log('File uploaded — MIME:', mimeType, '| Base64:', base64Payload);
          msg.fileUpload = {
            ...msg.fileUpload,
            state: 'done',
            progress: 100,
            dataUrl,
            mimeType,
            base64Payload
          };
          this.scrollToBottom();
        });
      })
      .catch(() => {
        this.ngZone.run(() => {
          this.clearUploadProgressTimers();
          const msg = this.messages[messageIndex];
          if (msg?.fileUpload) {
            msg.fileUpload = {
              ...msg.fileUpload,
              state: 'error',
              progress: 0
            };
          }
          this.scrollToBottom();
        });
      });
  }

  private convertFileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          resolve(result);
        } else {
          reject(new Error('Unexpected read result'));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  /** Split `data:<mime>[;params];base64,<payload>` — MIME is the type before the first `;`. */
  private static parseDataUrl(dataUrl: string): { mimeType: string; base64Payload: string } {
    const marker = ';base64,';
    const i = dataUrl.indexOf(marker);
    if (i === -1 || !dataUrl.startsWith('data:')) {
      return { mimeType: 'application/octet-stream', base64Payload: dataUrl };
    }
    const meta = dataUrl.slice('data:'.length, i);
    const mimeType = meta.split(';')[0]?.trim() || 'application/octet-stream';
    const base64Payload = dataUrl.slice(i + marker.length);
    return { mimeType, base64Payload };
  }

  private clearUploadProgressTimers(): void {
    this.uploadProgressTimers.forEach((id) => clearTimeout(id));
    this.uploadProgressTimers = [];
  }

  /**
   * Cosmetic progress while `FileReader` runs; caps below 100% until `encodeFileToBase64` finishes.
   */
  private runUploadProgressSimulation(messageIndex: number): void {
    const totalMs = 1800;
    const steps = 36;
    const stepMs = Math.max(30, Math.floor(totalMs / steps));
    let step = 0;
    const maxSimulated = 92;

    const tick = (): void => {
      this.ngZone.run(() => {
        const msg = this.messages[messageIndex];
        if (!msg?.fileUpload || msg.fileUpload.state !== 'uploading') {
          return;
        }
        step += 1;
        const progress = Math.min(maxSimulated, Math.round((step / steps) * maxSimulated));
        msg.fileUpload = { ...msg.fileUpload, progress };
        if (progress >= maxSimulated) {
          return;
        }
        const id = setTimeout(() => tick(), stepMs);
        this.uploadProgressTimers.push(id);
      });
    };

    const firstId = setTimeout(() => tick(), 0);
    this.uploadProgressTimers.push(firstId);
  }

  /** PDF, common images, CSV, Excel only. */
  private isAllowedUploadFile(file: File): boolean {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const allowedExt = new Set([
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'bmp',
      'svg',
      'csv',
      'xls',
      'xlsx'
    ]);
    if (allowedExt.has(ext)) {
      return true;
    }
    const mime = file.type.toLowerCase();
    if (mime === 'application/pdf') {
      return true;
    }
    if (mime.startsWith('image/')) {
      return true;
    }
    if (mime === 'text/csv' || mime === 'application/csv') {
      return true;
    }
    if (mime === 'application/vnd.ms-excel') {
      return true;
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      return true;
    }
    return false;
  }

  toggleVoiceInput(): void {
    if (!this.voiceInputSupported || !this.speechRecognition) {
      this.addMessage('Speech to text is not supported in this browser.');
      return;
    }

    if (this.isListening) {
      this.speechRecognition.stop();
      return;
    }

    this.speechSessionAccumulated = '';
    this.isListening = true;
    this.speechRecognition.start();
  }

  /** Show intro text above link card when it is not just the raw URL. */
  messageLinkIntroVisible(message: ChatMessage): boolean {
    if (!message.linkUrl || !message.content?.trim()) {
      return false;
    }
    const c = message.content.trim();
    if (c === message.linkUrl) {
      return false;
    }
    try {
      if (new URL(c).href === message.linkUrl) {
        return false;
      }
    } catch {
      /* keep true below */
    }
    return true;
  }

  /** Hostname for link preview line. */
  linkMessageHost(message: ChatMessage): string {
    if (!message.linkUrl) {
      return '';
    }
    try {
      return new URL(message.linkUrl).hostname.replace(/^www\./, '');
    } catch {
      return message.linkUrl;
    }
  }

  async copyBotMessage(message: ChatMessage): Promise<void> {
    const parts: string[] = [];
    if (message.linkUrl) {
      if (message.linkTitle?.trim()) {
        parts.push(message.linkTitle.trim());
      }
      parts.push(message.linkUrl);
    }
    const body = message.content?.trim() ?? '';
    if (body && (!message.linkUrl || body !== message.linkUrl)) {
      parts.push(body);
    }
    const text = parts.join('\n').trim();
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }
  }

  handleSendMessage(): void {
    const message = this.messageInput.trim();
    if (!message) {
      return;
    }

    const normalizedUrl = this.normalizeMessageAsLinkUrl(message);
    if (normalizedUrl) {
      this.messages.push({ content: message, isUser: true, linkUrl: normalizedUrl });
      this.scrollToBottom();
    } else {
      this.addMessage(message, true);
    }
    this.messageInput = '';
    this.simulateBotResponse(message);
  }

  reloadChat(): void {
    this.clearUploadProgressTimers();
    if (this.botReplyTimer) {
      clearTimeout(this.botReplyTimer);
      this.botReplyTimer = undefined;
    }
    this.isTyping = false;
    this.messageInput = '';
    this.messages = [
      {
        content:
          "Hello! I'm Bizzy, your AI payroll & tax agent. Upload a payslip to simulate tax scenarios or decode your deductions. How can I help you optimize your take-home pay today?",
        isUser: false
      }
    ];
    this.isToolsOpen = false;
    this.openBubbleMenuIndex = null;
    this.scrollToBottom();
  }

  private addMessage(content: string, isUser = false): void {
    this.messages.push({ content, isUser });
    this.scrollToBottom();
  }

  /**
   * If the whole message is a single URL (or www… / domain-only), returns a normalized https URL.
   */
  private normalizeMessageAsLinkUrl(raw: string): string | null {
    const t = raw.trim();
    if (!t || /\s/.test(t)) {
      return null;
    }
    try {
      if (/^https?:\/\//i.test(t)) {
        return new URL(t).href;
      }
    } catch {
      return null;
    }
    if (/^www\./i.test(t)) {
      try {
        return new URL(`https://${t}`).href;
      } catch {
        return null;
      }
    }
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(t)) {
      try {
        return new URL(`https://${t}`).href;
      } catch {
        return null;
      }
    }
    return null;
  }

  private simulateBotResponse(userMessage: string): void {
    const responseDelay = Math.floor(Math.random() * 1000) + 1500;

    this.isTyping = true;
    this.scrollToBottom();

    this.botReplyTimer = setTimeout(() => {
      this.isTyping = false;
      if (Math.random() < 0.22) {
        this.messages.push({
          content: 'You may find this resource useful:',
          isUser: false,
          linkUrl: 'https://www.biz2credit.com',
          linkTitle: 'Biz2Credit — small business financing'
        });
      } else {
        const responses = [
          `I understand you're asking about "${userMessage}". Could you elaborate?`,
          `That is an interesting point about "${userMessage}". Let me help you with that.`,
          `I have analyzed your message about "${userMessage}". Here is what I think...`
        ];
        this.addMessage(responses[Math.floor(Math.random() * responses.length)]);
      }
      this.scrollToBottom();
      this.botReplyTimer = undefined;
    }, responseDelay);
  }

  private scrollToBottom(): void {
    const container = this.chatContainer?.nativeElement;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }

  private flushSpeechToInput(): void {
    const addition = this.speechSessionAccumulated.trim();
    this.speechSessionAccumulated = '';
    if (!addition) {
      return;
    }
    const cur = this.messageInput.trim();
    this.messageInput = cur ? `${cur} ${addition}` : addition;
  }

  private ensureSpeechRecognition(): boolean {
    const win = window as Window & {
      SpeechRecognition?: new () => BrowserSpeechRecognition;
      webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
    };
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      return false;
    }

    this.speechRecognition = new RecognitionCtor();
    this.speechRecognition.lang = 'en-US';
    this.speechRecognition.interimResults = false;
    this.speechRecognition.continuous = true;

    this.speechRecognition.onresult = (event: SpeechRecognitionEventLite) => {
      this.ngZone.run(() => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal === false) {
            continue;
          }
          this.speechSessionAccumulated += result[0]?.transcript ?? '';
        }
      });
    };

    this.speechRecognition.onerror = () => {
      this.ngZone.run(() => {
        this.flushSpeechToInput();
        this.isListening = false;
      });
    };

    this.speechRecognition.onend = () => {
      this.ngZone.run(() => {
        this.flushSpeechToInput();
        this.isListening = false;
      });
    };

    return true;
  }

  ngOnDestroy(): void {
    this.clearUploadProgressTimers();
    if (this.botReplyTimer) {
      clearTimeout(this.botReplyTimer);
    }
    this.speechRecognition?.stop();
  }
}
