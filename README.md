# Fast | The Open-Source AI-Native IDE

**One IDE. Your AI agents. Your workflow.**

Fast is a lightweight, open-source desktop IDE built for the next generation of software development.

Bring your code, terminal, workspace and AI coding agents together in one focused development environment. Choose between Claude Code, OpenAI Codex or Google Antigravity, and build software your way.

Built with **Rust, Tauri 2, React and TypeScript**, Fast combines native performance with a modern development experience.


<p align="center">
  <a href="https://github.com/MaelDvllrs/Fast-IDE/stargazers">
    <img src="https://img.shields.io/github/stars/MaelDvllrs/Fast-IDE?style=flat-square&color=yellow" alt="GitHub stars" />
  </a>
  <a href="https://github.com/MaelDvllrs/Fast-IDE/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/MaelDvllrs/Fast-IDE?style=flat-square" alt="MIT License" />
  </a>
  <a href="https://github.com/MaelDvllrs/Fast-IDE">
    <img src="https://img.shields.io/github/last-commit/MaelDvllrs/Fast-IDE?style=flat-square" alt="Last commit" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue?style=flat-square" alt="Windows and macOS" />
  <img src="https://img.shields.io/badge/open%20source-MIT-green?style=flat-square" alt="Open source" />
</p>

---

## Why Fast?

Software development is changing. AI coding agents are becoming an essential part of how developers build, debug and maintain applications.

But developers shouldn't have to compromise their workflow to use them.

Fast brings everything together in a single desktop application, giving you a dedicated environment to work with your favorite AI coding tools.

Instead of switching between multiple applications, terminals and interfaces, you get one workspace designed around how modern developers actually build software.

Fast is built around three principles:

- **Freedom:** Choose the AI coding agent that fits your workflow.
- **Simplicity:** Keep your development environment clean and focused.
- **Performance:** Enjoy a lightweight desktop application powered by native technologies.

## AI Coding Agents

Use your preferred AI coding agent without being locked into a single ecosystem.

Fast is designed around three major AI development tools.

### Claude Code



[Claude Code](https://code.claude.com/) is Anthropic's agentic coding tool. It understands your codebase, executes commands, edits files and helps you build complete software projects.

### OpenAI Codex



[OpenAI Codex](https://openai.com/codex/) is OpenAI's coding agent, designed to help developers write, understand and execute code through AI-powered workflows.

### Google Antigravity



[Google Antigravity](https://antigravity.google/) brings an agent-first approach to software development, helping developers coordinate AI-assisted coding workflows.

**Your IDE. Your choice. Your AI.**

## Features

Fast aims to provide everything you need for an efficient AI-powered development workflow.

- **Multiple AI agents:** Work with Claude Code, OpenAI Codex or Google Antigravity.
- **Minimal code editor:** A clean editing experience powered by CodeMirror 6.
- **Project explorer:** Navigate and manage your project files directly from the workspace.
- **Integrated terminal:** Access your development environment without leaving Fast.
- **Native desktop application:** Built with Rust and Tauri 2 for a lightweight experience.
- **Modern interface:** A focused UI designed to reduce distractions and context switching.
- **Cross-platform architecture:** Designed for Windows and macOS.
- **Developer-first workflow:** Keep your tools, code and AI agents in one place.

> Fast is actively evolving. Some integrations and features may depend on the current development version.

## Screenshots

<p align="center">
  <img
    src="https://cxvrpdzddzvxspgbsyke.supabase.co/storage/v1/object/public/media/fast-1.avif"
    alt="Fast IDE - IDE section"
    width="100%"
  />
</p>

<p align="center">
  <img
    src="https://cxvrpdzddzvxspgbsyke.supabase.co/storage/v1/object/public/media/fast-2.avif"
    alt="Fast IDE - IDE section"
    width="100%"
  />
</p>

<p align="center">
  <img
    src="https://cxvrpdzddzvxspgbsyke.supabase.co/storage/v1/object/public/media/fast-setting.avif"
    alt="Fast IDE - IDE section"
    width="100%"
  />
</p>

## Tech Stack

Fast combines a modern frontend with a native backend to deliver a responsive desktop experience.

| Technology | Purpose |
|---|---|
| Rust | Native backend and system operations |
| Tauri 2 | Desktop application framework |
| React 19 | User interface |
| TypeScript | Type-safe frontend development |
| Vite | Frontend development and build tooling |
| CodeMirror 6 | Code editor |
| xterm.js | Terminal interface |
| AI coding agents | Claude Code, OpenAI Codex and Google Antigravity |

### Architecture

Fast uses a modular architecture that separates the native backend from the frontend.

**Frontend**

- React components and application state.
- Code editor and workspace interface.
- AI agent interaction panels.
- File explorer and terminal UI.

**Backend**

- Rust system operations.
- Filesystem management.
- Process and agent management.
- Native operating system integrations.

**Communication**

- Tauri IPC for frontend and backend communication.
- Events for asynchronous operations.
- Platform-specific modules for Windows and macOS.

This separation makes Fast easier to maintain, extend and contribute to.

## Getting Started

Want to try Fast or contribute to its development?

### Prerequisites

Make sure you have the following tools installed:

- [Node.js 20+](https://nodejs.org/)
- [Rust (stable)](https://rustup.rs/)
- [Git](https://git-scm.com/)

You'll also need the CLI or runtime requirements for whichever AI coding agent you want to use.

#### Windows

Install:

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with Desktop development with C++.
- [Microsoft WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

#### macOS

Install Xcode Command Line Tools:

```bash
xcode-select --install
```

### Installation

Clone the repository:

```bash
git clone https://github.com/MaelDvllrs/Fast-IDE.git
```

Navigate to the project:

```bash
cd Fast-IDE
```

Install dependencies:

```bash
npm install
```

### Development

Start Fast in development mode:

```bash
npm run tauri dev
```

The desktop application will launch locally.

### Production Build

Build the application for your current operating system:

```bash
npm run tauri build
```

### Available Commands

| Command | Description |
|---|---|
| `npm install` | Install project dependencies |
| `npm run tauri dev` | Start the desktop application |
| `npm run tauri build` | Build the native desktop application |
| `npm run typecheck` | Run TypeScript checks |
| `npm run build` | Build the frontend |
| `npm run icons` | Generate file icons |
| `npm run app-icon` | Generate application icons |

## Project Structure

```text
Fast-IDE/
├── src/
│   ├── components/
│   │   ├── Editor/
│   │   ├── FileTree/
│   │   └── ClaudePanel/
│   ├── lib/
│   │   └── ipc.ts
│   ├── platform/
│   │   ├── windows.ts
│   │   └── macos.ts
│   ├── App.tsx
│   └── main.tsx
│
├── src-tauri/
│   ├── capabilities/
│   └── src/
│       ├── commands/
│       ├── fs/
│       ├── claude/
│       └── platform/
│           ├── windows.rs
│           └── macos.rs
│
├── scripts/
├── package.json
└── vite.config.ts
```

*The structure may evolve as additional AI agent integrations are introduced.*

## Contributing

Fast is an open-source project. Contributions, feedback and ideas are welcome.

Whether you're a Rust developer, frontend engineer, designer or AI tooling enthusiast, there's room to contribute.

### How to Contribute

1. Fork the repository.
2. Create a new feature branch.
3. Implement your changes.
4. Test your implementation.
5. Submit a Pull Request.

```bash
git checkout -b feat/my-feature
```

### Contribution Guidelines

To keep the project maintainable:

- Follow the existing architecture and coding conventions.
- Keep platform-specific implementations isolated.
- Avoid unnecessary dependencies.
- Keep the interface consistent and accessible.
- Document new functionality.
- Test your changes before submitting a Pull Request.

### Found a Bug or Have an Idea?

We appreciate all feedback.

- [Report a bug](https://github.com/MaelDvllrs/Fast-IDE/issues)
- [Request a feature](https://github.com/MaelDvllrs/Fast-IDE/issues)
- [Explore existing issues](https://github.com/MaelDvllrs/Fast-IDE/issues)

## Roadmap

Fast is an evolving project. The long-term vision is to create a complete, extensible development environment built around AI agents.

Areas of development include:

- [ ] Expanded AI agent integrations.
- [ ] Multi-agent workflows and orchestration.
- [ ] Git integration and Git worktree management.
- [ ] Advanced agent session management.
- [ ] Improved terminal experience.
- [ ] Custom agent commands and workflows.
- [ ] Enhanced Windows and macOS support.
- [ ] Workspace customization.
- [ ] Improved developer productivity tools.

Have an idea? Open an issue and help shape the future of Fast.

## Philosophy

**The future of development is not about choosing one AI model. It's about having the freedom to use the right tools for the job.**

Fast is built on that belief.

We want developers to spend less time managing tools and more time building software.

No unnecessary complexity. No forced ecosystem. Just a better environment for modern software development.

## License

Fast is distributed under the [MIT License](LICENSE).

You are free to use, modify, distribute and build upon the project under the terms of the license.

## Support Fast

If you find Fast useful, consider supporting the project:

- ⭐ Star the repository.
- 🐛 Report bugs and suggest improvements.
- 🔧 Submit Pull Requests.
- 📢 Share Fast with other developers.

Every contribution helps the project grow.

---

<p align="center">
  <strong>One IDE. Your AI agents. Your workflow.</strong>
  <br /><br />
  <a href="https://github.com/MaelDvllrs/Fast-IDE">Explore Fast on GitHub</a>
</p>
