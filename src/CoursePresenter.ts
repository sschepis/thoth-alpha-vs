import * as vscode from 'vscode';
import { Course, CourseSlide, CourseManager } from './CourseManager';
import { setWebviewSecurity } from './webviewSecurity';

export class CoursePresenter implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _course?: Course;
    private _slides: CourseSlide[] = [];
    private _currentSlide = 0;
    private _viewMode: 'presentation' | 'study' = 'study';
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly _courseManager: CourseManager) {}

    async present(courseId: string, extensionUri: vscode.Uri) {
        const course = await this._courseManager.get(courseId);
        if (!course) {
            vscode.window.showErrorMessage('Course not found.');
            return;
        }

        this._course = course;
        this._slides = this._courseManager.flattenSlides(course);
        this._currentSlide = 0;

        if (this._slides.length === 0) {
            vscode.window.showErrorMessage('Course has no slides.');
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'thothAlpha.coursePresenter',
            `Course: ${course.title}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableCommandUris: false,
                enableFindWidget: false,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri)]
            }
        );
        setWebviewSecurity(this._panel.webview, 'https://cdn.jsdelivr.net');

        this._panel.webview.html = this._getHtml();
        this._sendSlide();

        this._panel.webview.onDidReceiveMessage(
            (message) => {
                switch (message.command) {
                    case 'next':
                        if (this._currentSlide < this._slides.length - 1) {
                            this._currentSlide++;
                            this._sendSlide();
                        }
                        return;
                    case 'prev':
                        if (this._currentSlide > 0) {
                            this._currentSlide--;
                            this._sendSlide();
                        }
                        return;
                    case 'goto':
                        if (message.index >= 0 && message.index < this._slides.length) {
                            this._currentSlide = message.index;
                            this._sendSlide();
                        }
                        return;
                    case 'toggleView':
                        this._viewMode = this._viewMode === 'presentation' ? 'study' : 'presentation';
                        this._sendSlide();
                        return;
                    case 'narrate':
                        vscode.commands.executeCommand('thothAlpha.openSearch');
                        return;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => {
            this._panel = undefined;
        }, null, this._disposables);
    }

    private _sendSlide() {
        if (!this._panel || !this._slides.length) { return; }
        const slide = this._slides[this._currentSlide];
        this._panel.webview.postMessage({
            command: 'slide',
            title: slide.title,
            markdown: slide.markdown,
            courseText: slide.courseText || '',
            narrationScript: slide.narrationScript,
            index: this._currentSlide,
            total: this._slides.length,
            courseTitle: this._course?.title || '',
            viewMode: this._viewMode
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Course Presenter</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" integrity="sha384-n8MVd4RsNHUEdHRw4Q6o4MBw4XMj1+1PYc+Z0VlU9NhqVhFeKxWDAeEkgQlNCVG" crossorigin="anonymous">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js" integrity="sha384-XjKyOOlGwcjNTAIQHIpgOBlnhOsM21E3OoAI1ljGBQEnNUZ4FLAAu0BbKVWLszJk" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" integrity="sha384-+VBxd3r6XgURycqtZ117nYw44OOcIax4c6dR8sY3FNSZHHw3F6LjJKOa1XM5BdC" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js" integrity="sha384-rxX2TaZqj4ZcZWtXNRdrw6ZnwCKJU5i0UFYPv5hFpKmrOxbEO9pRqojnXMxnVGn" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.3/dist/purify.min.js" integrity="sha384-osZDKVu4ipZP703HmPOhWdyBajcFyjX2Psjk//TG1Rc0AdwEtuToaylrmcK3LdAl" crossorigin="anonymous"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 24px;
            background: var(--vscode-titleBar-activeBackground, #333);
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            font-size: 13px;
        }
        .header .course-title { opacity: 0.7; }
        .header .header-right { display: flex; align-items: center; gap: 12px; }
        .header .slide-counter { font-weight: 600; }
        .slide-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow-y: auto;
        }
        .slide-content {
            padding: 48px;
            max-width: 900px;
            width: 100%;
            margin: 0 auto;
        }
        .slide-content h1 {
            font-size: 2.4em;
            margin-bottom: 24px;
            color: var(--vscode-textLink-foreground, #3794ff);
        }
        .slide-content h2 { font-size: 1.8em; margin: 20px 0 12px; }
        .slide-content h3 { font-size: 1.4em; margin: 16px 0 8px; }
        .slide-content p { font-size: 1.2em; line-height: 1.7; margin-bottom: 16px; }
        .slide-content ul, .slide-content ol { font-size: 1.2em; line-height: 1.7; padding-left: 24px; margin-bottom: 16px; }
        .slide-content code {
            background: var(--vscode-textCodeBlock-background, #2d2d2d);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.9em;
        }
        .slide-content pre {
            background: var(--vscode-textCodeBlock-background, #2d2d2d);
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            margin-bottom: 16px;
        }
        .slide-content pre code { background: none; padding: 0; }
        .course-text {
            padding: 32px 48px;
            max-width: 900px;
            width: 100%;
            margin: 0 auto;
            border-top: 2px solid var(--vscode-textLink-foreground, #3794ff);
            line-height: 1.8;
            font-size: 1.05em;
        }
        .course-text:empty { display: none; }
        .course-text p { margin-bottom: 14px; }
        .course-text h2, .course-text h3 { margin: 18px 0 10px; }
        .course-text code {
            background: var(--vscode-textCodeBlock-background, #2d2d2d);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.9em;
        }
        .course-text pre {
            background: var(--vscode-textCodeBlock-background, #2d2d2d);
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            margin-bottom: 16px;
        }
        .course-text pre code { background: none; padding: 0; }
        body.view-mode-presentation .course-text { display: none; }
        .controls {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
            padding: 16px;
            border-top: 1px solid var(--vscode-panel-border, #444);
        }
        button {
            padding: 8px 24px;
            border: 1px solid var(--vscode-button-border, #555);
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #fff);
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        button:disabled { opacity: 0.4; cursor: default; }
        .view-toggle {
            padding: 6px 16px;
            border: 1px solid var(--vscode-button-border, #555);
            background: transparent;
            color: var(--vscode-editor-foreground, #d4d4d4);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .view-toggle:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
        .speaker-notes {
            padding: 12px 24px;
            background: var(--vscode-textCodeBlock-background, #2d2d2d);
            border-top: 1px solid var(--vscode-panel-border, #444);
            font-size: 13px;
            opacity: 0.8;
            max-height: 100px;
            overflow-y: auto;
        }
        .speaker-notes:empty { display: none; }
        .katex-display { margin: 16px 0; }
    </style>
</head>
<body>
    <div class="header">
        <span class="course-title" id="courseTitle"></span>
        <div class="header-right">
            <button class="view-toggle" id="viewToggle" onclick="toggleView()">Presentation View</button>
            <span class="slide-counter" id="slideCounter"></span>
        </div>
    </div>
    <div class="slide-area">
        <div class="slide-content" id="slideContent"></div>
        <div class="course-text" id="courseText"></div>
    </div>
    <div class="speaker-notes" id="speakerNotes"></div>
    <div class="controls">
        <button id="prevBtn" onclick="prev()">← Previous</button>
        <button id="nextBtn" onclick="next()">Next →</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();

        function prev() { vscode.postMessage({ command: 'prev' }); }
        function next() { vscode.postMessage({ command: 'next' }); }
        function toggleView() { vscode.postMessage({ command: 'toggleView' }); }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === ' ') { next(); }
            else if (e.key === 'ArrowLeft') { prev(); }
            else if (e.key === 'v') { toggleView(); }
        });

        function renderMath(el) {
            if (typeof renderMathInElement !== 'undefined') {
                renderMathInElement(el, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false }
                    ]
                });
            }
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command === 'slide') {
                document.getElementById('courseTitle').textContent = msg.courseTitle;
                document.getElementById('slideCounter').textContent = (msg.index + 1) + ' / ' + msg.total;

                const slideEl = document.getElementById('slideContent');
                const titleEl = document.createElement('h1');
                titleEl.textContent = msg.title;
                const rawHtml = marked.parse(msg.markdown || '', { mangle: false, headerIds: false });
                const sanitizedHtml = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawHtml) : rawHtml;
                slideEl.innerHTML = '';
                slideEl.appendChild(titleEl);
                const contentDiv = document.createElement('div');
                contentDiv.innerHTML = sanitizedHtml;
                slideEl.appendChild(contentDiv);
                renderMath(slideEl);

                const courseTextEl = document.getElementById('courseText');
                if (msg.courseText) {
                    const rawCourseHtml = marked.parse(msg.courseText, { mangle: false, headerIds: false });
                    courseTextEl.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawCourseHtml) : rawCourseHtml;
                    renderMath(courseTextEl);
                } else {
                    courseTextEl.innerHTML = '';
                }

                document.getElementById('speakerNotes').textContent = msg.narrationScript || '';
                document.getElementById('prevBtn').disabled = msg.index === 0;
                document.getElementById('nextBtn').disabled = msg.index === msg.total - 1;

                document.body.className = msg.viewMode === 'presentation' ? 'view-mode-presentation' : '';
                document.getElementById('viewToggle').textContent =
                    msg.viewMode === 'presentation' ? 'Study View' : 'Presentation View';
            }
        });
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this._panel?.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}
