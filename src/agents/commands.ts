// Commandes « / » du champ de saisie des agents : chacune envoie un prompt
// préparé, complété par ce que l'utilisateur écrit après la commande.

export interface AgentCommand {
  /** Nom tapé après « / ». */
  name: string;
  /** Une ligne affichée dans le menu des commandes. */
  description: string;
  /** Ce qu'on peut écrire après la commande (affiché en grisé). */
  hint: string;
  /** Ne modifie aucun fichier : pas de commit / merge automatique en fin de tour. */
  readOnly: boolean;
  /** `commit` : FAST affiche ensuite le message proposé avec les boutons Commit / Push. */
  kind?: "commit";
  prompt: (args: string) => string;
}

/** Précision de l'utilisateur, ajoutée en fin de prompt. */
const focus = (args: string) => (args ? `\n\nFocus on: ${args}` : "");

const READ_ONLY = "Do not modify, create or delete any file, and do not run git commands that change the repository.";

export const COMMANDS: AgentCommand[] = [
  {
    name: "review",
    description: "Review recent changes: bugs, security, bad practices",
    hint: "what to focus on",
    readOnly: true,
    prompt: (args) =>
      `Review the recent changes in this repository. Run \`git status\` and \`git diff HEAD\`; if there are no uncommitted changes, review the last commit with \`git show HEAD\`.
Look for bugs, security issues and bad practices. ${READ_ONLY}
Report the problems grouped by severity (Critical, High, Medium, Low). For each one give the file and line, why it is a problem and how to fix it. If you find nothing worth reporting, say so plainly.${focus(args)}`,
  },
  {
    name: "test",
    description: "Find missing tests, run the relevant ones, fix failures",
    hint: "what to test",
    readOnly: false,
    prompt: (args) =>
      `Work on the tests of this project.
1. Find how tests are written and run here (framework, commands, existing test files).
2. Identify important code that has no test (unit, integration or regression) and add the missing tests.
3. Run the relevant tests.
4. If tests fail, find out why: fix the code when it has a bug, fix the test when the test is wrong.
Finish with a short summary: tests added, test results, and what you fixed.${focus(args)}`,
  },
  {
    name: "debug",
    description: "Find the root cause of an error and fix it",
    hint: "the error, logs or stack trace",
    readOnly: false,
    prompt: (args) =>
      `Debug this problem:
${args || "(no description given: look for the most recent error in the logs, the build or the tests, and ask me if it is unclear)"}

Reproduce it if you can, find the root cause (not just the symptom), apply the fix, then check that it works (run the code or the tests).
Finish with: the root cause, the fix, and how you verified it.`,
  },
  {
    name: "deps",
    description: "Main build failing: check the libraries you installed are declared and installed",
    hint: "the build error",
    readOnly: false,
    prompt: (args) =>
      `The production build fails on the main branch after your work was merged, probably because of a dependency (framework or library) your changes use or that you installed, but that the main branch does not have.
${args ? `
Build output:
\`\`\`
${args}
\`\`\`
` : ""}
Check and fix it:
1. List the packages your changes rely on: compare your branch with the main branch (\`git diff\` against their merge base), and look at new imports and at changes to package.json, the lockfile and other manifests (Cargo.toml, pyproject.toml, requirements.txt…).
2. Every package you use must be declared in the manifest (dependencies or devDependencies, as appropriate), with the lockfile updated by the project's package manager: the one whose lockfile is in the project (npm, pnpm, yarn or bun). Never edit a lockfile by hand.
3. FAST commits your work when you finish and only merges what is committed: make sure the manifest and lockfile changes are in your changes and not ignored by .gitignore.
4. Check that each package is really installed. In FAST, node_modules is shared between the project and the agents' worktrees: a package installed elsewhere (globally, in another folder or with another package manager) is missing for the main build. Install what is missing with the project's package manager.
5. Remove the dependencies you added but no longer use.
6. Run the build with the \`run_check\` tool of the \`fast\` MCP server (kind="build") and fix what still fails.
Finish with a short summary: what was missing, what you changed, and the build result.`,
  },
  {
    name: "commit",
    description: "Prepare a commit message from the current changes",
    hint: "notes for the message",
    readOnly: true,
    kind: "commit",
    prompt: (args) =>
      `Prepare a commit for the current changes. Run \`git status\` and \`git diff HEAD\` (staged and unstaged changes).
Check the changes for problems before committing: leftover debug code, secrets or credentials, unrelated or generated files. Mention anything suspicious.
${READ_ONLY} Do not stage and do not commit: I will commit from FAST.
Write a commit message following Conventional Commits: \`type(scope): summary\` (feat, fix, refactor, docs, test, chore…), imperative mood, at most 72 characters, then an optional body explaining what and why.
Put the final message alone in a fenced block with the language \`commit\`, like this:
\`\`\`commit
feat(scope): summary
\`\`\`${focus(args)}`,
  },
  {
    name: "ultracode",
    description: "Multi-agent orchestration for a thorough answer (many more tokens)",
    hint: "the task",
    readOnly: false,
    prompt: (args) => withUltracode(args || "Work on the task we discussed, as thoroughly as possible."),
  },
  {
    name: "explain",
    description: "Explain a file, module or data flow",
    hint: "file, module or flow",
    readOnly: true,
    prompt: (args) =>
      `Explain ${args ? `this part of the code: ${args}` : "how this project is organized"}.
Describe its role, its dependencies, how it interacts with the rest of the code and how data flows through it. Point to the important files and functions. ${READ_ONLY}`,
  },
];

/**
 * Mot-clé « ultracode » de Claude Code : placé dans un message, il fait traiter la
 * demande en orchestration multi-agents (workflows, vérifications croisées).
 * Utilisé par la commande /ultracode et par l'option Ultracode du menu d'effort.
 */
export const withUltracode = (prompt: string) => `ultracode\n\n${prompt}`;

/** `/review the auth module` → la commande et le reste du texte ; `null` sans commande connue. */
export function parseCommand(text: string): { command: AgentCommand; args: string } | null {
  const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = match && COMMANDS.find((c) => c.name === match[1].toLowerCase());
  return command ? { command, args: (match[2] ?? "").trim() } : null;
}

/** Message de commit proposé par l'agent : le dernier bloc \`\`\`commit de sa réponse. */
export function extractCommitMessage(text: string): string | null {
  const blocks = [...text.matchAll(/```commit[^\n]*\n([\s\S]*?)```/g)];
  const message = blocks.at(-1)?.[1].trim();
  return message || null;
}
