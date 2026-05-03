# Thoth Alpha

**Thoth Alpha** is a cutting-edge, AI-powered computational search engine built directly into VS Code. It leverages built-in language models (via `vscode.lm`) to parse your queries, query your active code and workspace data, and instantly generate interactive visualizations, computations, and scripts locally.

## Features

- **Native VS Code LLM Integration:** Uses the built-in `vscode.lm` API (Copilot/Claude) to do all the heavy lifting—no API keys required. Includes a dropdown to select models!
- **Context-Aware Editor Queries:** Automatically grabs your highlighted code (or active file) and uses it as context when you ask questions.
- **Workspace Data RAG:** Uses the "Database" toggle to search your workspace for `.json`, `.csv`, `.log`, and `.md` files and feeds them to the LLM. 
- **Local Execution Environment:** The LLM can write Python, Node, or Bash scripts to process data locally, and the extension spins up a subprocess to execute them securely and prints the stdout/stderr right in a terminal pod in the UI.
- **Interactive Computational Notebooks:** You can create and save `.thoth` files. They use our `ThothEditorProvider` to natively render as our interactive frontend, allowing you to save your computational searches to disk permanently!
- **Response Caching:** Built-in local cache in `.thothalpha` so repeating expensive queries loads instantly without hitting the LLM again.
- **Real-time Streaming:** The UI parses and streams partial JSON chunks, rendering the markdown and visualizations on the fly so you don't have to wait.
- **3D Interactive Simulations:** Includes `Three.js` and `OrbitControls`, enabling the LLM to generate interactive 3D visualizations inside the Lab canvas.
- **Native Styling:** The entire app dynamically adopts your VS Code themes using `var(--vscode-...)` CSS variables.

## Getting Started

1. Install the extension.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type **Thoth Alpha: Open Search** to open the side panel.
3. Type a query, e.g., "Simulate a 3D solar system with planets" or "Graph the latency logs" if you have Workspace Context enabled.
4. Or, create a new file with the `.thoth` extension to use it as a Computational Notebook and have your searches saved automatically.

## Requirements

- VS Code ^1.90.0
- An active subscription or extension that provides `vscode.lm` chat models (e.g., GitHub Copilot Chat).

## License

MIT License. See `LICENSE` for more details.