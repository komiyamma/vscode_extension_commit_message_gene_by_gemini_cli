import * as vscode from 'vscode';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// Keep prompt input bounded so the model receives a stable, digestible payload.
const MAX_SECTION_LENGTH = 3000;
// Soft cap for git stdout so large diffs do not blow up the prompt or buffers.
const GIT_STDOUT_SOFT_LIMIT = 40000;
// Commit messages can include a subject plus a body, so keep enough headroom for longer replies.
const MAX_OUTPUT_TOKENS = 4096;
// Use the Gemini 3 Flash preview model for short commit messages.
const MODEL_CANDIDATES = ['gemini-2.5-flash'] as const;

type GitRepositoryLike = {
	rootUri?: vscode.Uri;
	inputBox?: { value: string };
	ui?: { selected?: boolean };
};

type GeminiCoreModule = {
	AuthType: {
		LOGIN_WITH_GOOGLE: string;
		LEGACY_CLOUD_SHELL: string;
		COMPUTE_ADC: string;
	};
	getAuthTypeFromEnv: () => string | undefined;
	createCodeAssistContentGenerator: (
		httpOptions: { headers?: Record<string, string> },
		authType: string,
		config: CodeAssistRuntimeConfig,
		sessionId?: string,
	) => Promise<GeminiRuntime['generator']>;
};

type CodeAssistRuntimeConfig = {
	getProxy: () => string | undefined;
	isBrowserLaunchSuppressed: () => boolean;
	isInteractive: () => boolean;
	getAcpMode: () => boolean;
	getValidationHandler: () => undefined;
};

type GeminiRuntime = {
	generator: {
		generateContent(request: unknown, userPromptId: string, role: unknown): Promise<unknown>;
	};
	authType: string;
};

type WorkspaceRunEntry = {
	runId: number;
	statusItem: vscode.StatusBarItem;
	abortController: AbortController;
};

type WorkspaceClientEntry = {
	workspaceDir: string;
	authKey: string;
	ready: Promise<GeminiRuntime>;
};

type ErrorDiagnostics = {
	name: string;
	message: string;
	status?: number;
	code?: string | number;
	stack?: string;
};

const ERROR_DIAGNOSTICS_LOGGED = '__commitMessageGeneErrorDiagnosticsLogged';

type LoggedError = Error & {
	[ERROR_DIAGNOSTICS_LOGGED]?: boolean;
};

class GeminiClientPool {
	private readonly clients = new Map<string, WorkspaceClientEntry>();

	constructor(private readonly debug: (message: string) => void) {}

	async getClient(workspaceDir: string): Promise<GeminiRuntime> {
		const key = await this.buildCacheKey(workspaceDir);
		const existing = this.clients.get(key);
		if (existing) {
			return existing.ready;
		}

		const entry: WorkspaceClientEntry = {
			workspaceDir,
			authKey: key,
			ready: Promise.resolve(undefined as never),
		};

		entry.ready = (async () => {
			const core = await loadGeminiCore();
			const authType = resolveAuthType(core);
			this.debug(`creating gemini-cli-core code-assist generator: workspaceDir=${workspaceDir} authType=${authType}`);

			const generator = await core.createCodeAssistContentGenerator(
				{
					headers: {
						'User-Agent': 'commit-message-gene-by-gemini-cli',
					},
				},
				authType,
				createCodeAssistConfig(),
				workspaceDir,
			);
			const runtime: GeminiRuntime = {
				generator: generator as GeminiRuntime['generator'],
				authType: String(authType),
			};

			this.debug(`gemini-cli-core generator ready: workspaceDir=${workspaceDir} authType=${authType}`);
			return runtime;
		})().catch(async (error) => {
			this.clients.delete(key);
			throw error;
		});

		this.clients.set(key, entry);
		return entry.ready;
	}

	prefetchCurrentWorkspace(): void {
		void (async () => {
			const workspaceDir = await resolveWorkspaceDirectory();
			if (!workspaceDir) {
				return;
			}
			await this.getClient(workspaceDir);
		})().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.debug(`gemini-cli-core prewarm failed: ${message}`);
		});
	}

	async dispose(): Promise<void> {
		this.clients.clear();
	}

	private async buildCacheKey(workspaceDir: string): Promise<string> {
		const core = await loadGeminiCore();
		const authType = resolveAuthType(core);
		return JSON.stringify({
			workspaceDir: normalizeFsPath(workspaceDir),
			authType,
		});
	}
}

let clientPool: GeminiClientPool | undefined;

const M = {
	status: {
		processing: () => (isJapanese() ? '$(sync~spin) コミットメッセージを生成しています...' : '$(sync~spin) Generating commit message...'),
	},
	commitArea: {
		warnNoAccess: () => (isJapanese() ? 'コミットメッセージ欄にアクセスできませんでした。' : 'Unable to access commit message input.'),
		errorSet: (e: string) => (isJapanese() ? `コミットメッセージの設定に失敗しました: ${e}` : `Failed to set commit message: ${e}`),
	},
	errors: {
		noResult: () => (isJapanese() ? 'Gemini CLI core から有効なコミットメッセージを受信できませんでした。' : 'No valid commit message was received from Gemini CLI core.'),
		failed: (e: string) => (isJapanese() ? `Gemini CLI core の実行に失敗しました: ${e}` : `Failed to run Gemini CLI core: ${e}`),
	},
};

export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('commit message gene');
	const statusSpinner = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	context.subscriptions.push(output, statusSpinner);
	const debug = (_message: string) => {};

	clientPool = new GeminiClientPool(debug);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			clientPool?.prefetchCurrentWorkspace();
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			clientPool?.prefetchCurrentWorkspace();
		}),
	);
	clientPool.prefetchCurrentWorkspace();

	const activeRuns = new Map<string, WorkspaceRunEntry>();
	let runCounter = 0;

	const disposable = vscode.commands.registerCommand('commit-message-gene-by-gemini-cli.runGeminiCLICmd', async () => {
		let currentRunId = 0;
		let workspaceKey = '';

		try {
			debug(`extension start: node=${process.version} platform=${process.platform} cwd=${process.cwd()}`);
			const workspaceDir = await resolveWorkspaceDirectory();
			if (!workspaceDir) {
				vscode.window.showErrorMessage('No workspace folder is open, so Git context cannot be gathered.');
				return;
			}

			workspaceKey = normalizeFsPath(workspaceDir);
			const previous = activeRuns.get(workspaceKey);
			currentRunId = ++runCounter;
			const statusItem = previous?.statusItem ?? vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
			statusItem.text = M.status.processing();
			statusItem.show();

			const abortController = new AbortController();
			if (previous) {
				previous.abortController.abort();
			}
			activeRuns.set(workspaceKey, {
				runId: currentRunId,
				statusItem,
				abortController,
			});

			const gitContext = await collectGitContext(workspaceDir);
			debug(`gitContext length=${gitContext.length}`);
			const prompt = buildPrompt(gitContext);
			debug(`prompt length=${prompt.length}`);

			const { generator, authType } = await (clientPool?.getClient(workspaceDir) ?? Promise.reject(new Error('Gemini client pool is not available.')));
			debug(`gemini authType=${authType}`);
			const { result, model } = await generateCommitMessage(generator, prompt, debug);
			debug(`generateContent completed: model=${model} ${describeResult(result)}`);

			if (!isCurrentRun(activeRuns, workspaceKey, currentRunId)) {
				return;
			}

			let finalMessage = extractGeneratedMessage(result)?.trim();
			debug(`finalMessage length=${finalMessage?.length ?? 0}`);
			if (finalMessage) {
				finalMessage = normalizeCommitMessage(finalMessage);
				await setCommitMessage(finalMessage, output, workspaceDir);
			} else {
				reportError(M.errors.noResult(), output);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debug(`error: ${message}`);
			if (!wasErrorDiagnosticsLogged(error)) {
				appendErrorDiagnostics(output, 'commit-message generation run failed', error);
			}
			reportError(M.errors.failed(message), output);
		} finally {
			const current = activeRuns.get(workspaceKey);
			if (current && current.runId === currentRunId) {
				current.statusItem.hide();
				current.statusItem.dispose();
				activeRuns.delete(workspaceKey);
			}
		}
	});

	context.subscriptions.push(disposable);
}

export async function deactivate() {
	if (!clientPool) {
		return;
	}
	await clientPool.dispose();
	clientPool = undefined;
}

async function loadGeminiCore(): Promise<GeminiCoreModule> {
	return (await import('@google/gemini-cli-core')) as unknown as GeminiCoreModule;
}

function resolveAuthType(core: GeminiCoreModule): string {
	const detected = core.getAuthTypeFromEnv();
	if (detected === core.AuthType.COMPUTE_ADC || detected === core.AuthType.LEGACY_CLOUD_SHELL) {
		return core.AuthType.COMPUTE_ADC;
	}
	return core.AuthType.LOGIN_WITH_GOOGLE;
}

function createCodeAssistConfig(): CodeAssistRuntimeConfig {
	return {
		getProxy: () => undefined,
		isBrowserLaunchSuppressed: () => false,
		isInteractive: () => true,
		getAcpMode: () => false,
		getValidationHandler: () => undefined,
	};
}

function isCurrentRun(activeRuns: Map<string, WorkspaceRunEntry>, workspaceKey: string, runId: number): boolean {
	return activeRuns.get(workspaceKey)?.runId === runId;
}

type GenerateCommitMessageResult = {
	result: unknown;
	model: string;
};

async function generateCommitMessage(
	generator: GeminiRuntime['generator'],
	prompt: string,
	debug: (message: string) => void,
): Promise<GenerateCommitMessageResult> {
	const requestBase = {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		config: {
			temperature: 0.2,
			topP: 1,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		},
	};

	let lastError: Error | undefined;

	for (let pass = 0; pass < 2; pass += 1) {
		for (let index = 0; index < MODEL_CANDIDATES.length; index += 1) {
			const model = MODEL_CANDIDATES[index];
			const request = {
				...requestBase,
				model,
			};

			debug(`generateContent request: model=${model} promptLength=${prompt.length} pass=${pass + 1}`);

			try {
				const result = await generator.generateContent(request, `commit-message-${Date.now()}`, 'main');
				const finalMessage = extractGeneratedMessage(result)?.trim();
				if (finalMessage) {
					return {
						result,
						model,
					};
				}

				lastError = new Error(`Model ${model} returned no valid commit message.`);
				debug(`generateContent returned empty content: model=${model}`);
			} catch (error) {
				debug(`generateContent failed: model=${model} error=${describeError(error)}`);
				lastError = error instanceof Error ? error : new Error(toErrorMessage(error));
			}
		}

		break;
	}

	throw lastError ?? new Error(`All model attempts failed: ${MODEL_CANDIDATES.join(', ')}`);
}

function describeResult(result: unknown): string {
	if (!result || typeof result !== 'object') {
		return typeof result;
	}
	const candidate = result as { candidates?: Array<{ content?: { parts?: unknown[] } }>; responseId?: unknown };
	const parts = candidate.candidates?.[0]?.content?.parts;
	const partCount = Array.isArray(parts) ? parts.length : 0;
	const responseId = typeof candidate.responseId === 'string' ? candidate.responseId : '';
	return responseId ? `object responseId=${responseId} parts=${partCount}` : `object parts=${partCount}`;
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.stack || `${error.name}: ${error.message}`;
	}
	if (typeof error === 'object' && error !== null) {
		try {
			return JSON.stringify(error);
		} catch {
			return Object.prototype.toString.call(error);
		}
	}
	return String(error);
}

function getErrorDiagnostics(error: unknown): ErrorDiagnostics {
	const diagnostics: ErrorDiagnostics = {
		name: 'unknown',
		message: toErrorMessage(error),
	};

	if (error instanceof Error) {
		diagnostics.name = error.name || diagnostics.name;
		if (error.stack) {
			diagnostics.stack = error.stack;
		}
	}

	if (typeof error === 'object' && error !== null) {
		const candidate = error as {
			name?: unknown;
			message?: unknown;
			status?: unknown;
			code?: unknown;
			response?: { status?: unknown };
			stack?: unknown;
		};
		if (typeof candidate.name === 'string') {
			diagnostics.name = candidate.name;
		}
		if (typeof candidate.message === 'string') {
			diagnostics.message = candidate.message;
		}
		if (typeof candidate.status === 'number') {
			diagnostics.status = candidate.status;
		} else if (typeof candidate.response?.status === 'number') {
			diagnostics.status = candidate.response.status;
		}
		if (typeof candidate.code === 'number' || typeof candidate.code === 'string') {
			diagnostics.code = candidate.code;
		}
		if (!diagnostics.stack && typeof candidate.stack === 'string') {
			diagnostics.stack = candidate.stack;
		}
	}

	return diagnostics;
}

function formatOptionalValue(value: string | number | undefined): string {
	return value === undefined ? 'n/a' : String(value);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, ' ').trim();
}

function extractGeneratedMessage(result: unknown): string | undefined {
	if (typeof result === 'string') {
		return result;
	}
	if (!result || typeof result !== 'object') {
		return undefined;
	}

	const candidate = result as {
		text?: unknown;
		candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
		finalResponse?: unknown;
		content?: unknown;
		data?: { content?: unknown };
		message?: { content?: unknown };
		messages?: Array<{ role?: string; content?: unknown }>;
	};

	if (typeof candidate.finalResponse === 'string') {
		return candidate.finalResponse;
	}
	if (typeof candidate.text === 'string') {
		return candidate.text;
	}
	if (typeof candidate.content === 'string') {
		return candidate.content;
	}
	if (typeof candidate.data?.content === 'string') {
		return candidate.data.content;
	}
	if (typeof candidate.message?.content === 'string') {
		return candidate.message.content;
	}
	if (Array.isArray(candidate.messages)) {
		for (let i = candidate.messages.length - 1; i >= 0; i -= 1) {
			const entry = candidate.messages[i];
			if (entry?.role === 'assistant' && typeof entry.content === 'string') {
				return entry.content;
			}
		}
	}
	const parts = candidate.candidates?.[0]?.content?.parts;
	if (Array.isArray(parts)) {
		const text = parts.map(part => (typeof part.text === 'string' ? part.text : '')).join('').trim();
		if (text.length > 0) {
			return text;
		}
	}

	return undefined;
}

function normalizeCommitMessage(message: string): string {
	let normalized = message.trim();
	if (normalized.startsWith('```') && normalized.endsWith('```')) {
		normalized = normalized.slice(3, -3).trim();
	}
	if (normalized.startsWith('`') && normalized.endsWith('`')) {
		normalized = normalized.slice(1, -1).trim();
	}
	if (normalized.startsWith('**') && normalized.endsWith('**')) {
		normalized = normalized.slice(2, -2).trim();
	}
	return normalized;
}

async function setCommitMessage(message: string, output: vscode.OutputChannel, workspaceDir?: string) {
	try {
		await vscode.commands.executeCommand('workbench.view.scm');
		const gitApi = await getGitApi();
		if (gitApi) {
			const repos = (gitApi.repositories ?? []) as GitRepositoryLike[];
			const targetRepo = selectRepositoryForCommit(repos, workspaceDir);
			if (targetRepo?.inputBox) {
				targetRepo.inputBox.value = message;
				return;
			}
		}

		const scmAny = vscode.scm as unknown as { inputBox?: { value: string } };
		if (scmAny && scmAny.inputBox) {
			scmAny.inputBox.value = message;
			return;
		}

		output.appendLine(M.commitArea.warnNoAccess());
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		output.appendLine(M.commitArea.errorSet(errorMessage));
	}
}

function selectRepositoryForCommit(repos: GitRepositoryLike[], workspaceDir?: string) {
	if (!repos || repos.length === 0) {
		return undefined;
	}

	if (workspaceDir) {
		const byContext = findRepoByFsPath(repos, workspaceDir);
		if (byContext) {
			return byContext;
		}
	}

	const selected = repos.find(repo => repo?.ui?.selected);
	if (selected) {
		return selected;
	}

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
		if (activeFolder?.uri?.fsPath) {
			const byActive = findRepoByFsPath(repos, activeFolder.uri.fsPath);
			if (byActive) {
				return byActive;
			}
		}
	}

	return repos[0];
}

function normalizeFsPath(fsPath: string): string {
	const normalized = path.normalize(fsPath);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function findRepoByFsPath(repos: GitRepositoryLike[], targetFsPath: string) {
	const normalizedTarget = normalizeFsPath(targetFsPath);
	return repos.find(repo => repo?.rootUri?.fsPath && normalizeFsPath(repo.rootUri.fsPath) === normalizedTarget);
}

function reportError(message: string, output: vscode.OutputChannel) {
	output.appendLine(message);
	output.show(true);
	vscode.window.showErrorMessage(message);
}

function appendErrorDiagnostics(output: vscode.OutputChannel, context: string, error: unknown) {
	const diagnostics = getErrorDiagnostics(error);
	markErrorDiagnosticsLogged(error);
	output.appendLine(`[error] ${context}`);
	output.appendLine(`[error] name=${diagnostics.name}`);
	output.appendLine(`[error] status=${formatOptionalValue(diagnostics.status)}`);
	output.appendLine(`[error] code=${formatOptionalValue(diagnostics.code)}`);
	output.appendLine(`[error] message=${diagnostics.message}`);
	if (diagnostics.stack) {
		output.appendLine(`[error] stack=${oneLine(diagnostics.stack)}`);
	}
}

function markErrorDiagnosticsLogged(error: unknown): void {
	if (typeof error !== 'object' || error === null) {
		return;
	}
	try {
		(error as LoggedError)[ERROR_DIAGNOSTICS_LOGGED] = true;
	} catch {
		// Ignore frozen errors; the diagnostics were already written.
	}
}

function wasErrorDiagnosticsLogged(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	return (error as LoggedError)[ERROR_DIAGNOSTICS_LOGGED] === true;
}

async function getGitApi(): Promise<any | undefined> {
	const gitExt = vscode.extensions.getExtension('vscode.git');
	if (!gitExt) {
		return undefined;
	}
	const exportsAny = gitExt.isActive ? (gitExt.exports as any) : await gitExt.activate();
	return typeof exportsAny?.getAPI === 'function' ? exportsAny.getAPI(1) : exportsAny;
}

async function resolveWorkspaceDirectory(): Promise<string | undefined> {
	const gitApi = await getGitApi();
	const repos = (gitApi?.repositories ?? []) as GitRepositoryLike[];
	const selectedRepo = repos.find(repo => repo?.ui?.selected);
	if (selectedRepo?.rootUri?.fsPath) {
		return selectedRepo.rootUri.fsPath;
	}

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const containingWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
		if (containingWorkspace?.uri?.fsPath) {
			return containingWorkspace.uri.fsPath;
		}
	}

	if (repos.length > 0 && repos[0]?.rootUri?.fsPath) {
		return repos[0].rootUri.fsPath;
	}

	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function collectGitContext(cwd: string): Promise<string> {
	const gitVersion = await runGitCommand(['--version'], cwd);
	const repoRoot = await runGitCommand(['rev-parse', '--show-toplevel'], cwd);
	const branch = await (async () => {
		try {
			return await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		} catch (error) {
			const message = toErrorMessage(error);
			if (isHeadMissingError(message)) {
				return 'No commits yet (HEAD not created)';
			}
			throw error;
		}
	})();
	const status = await runGitCommand(['status', '--short', '--branch'], cwd);
	const stagedDiff = await runGitCommand(['diff', '--cached', '--color=never'], cwd, { softLimit: GIT_STDOUT_SOFT_LIMIT });
	let diffSectionTitle = 'Staged diff';
	let diffBody = stagedDiff;
	if (!diffBody) {
		diffSectionTitle = 'Working tree diff (no staged changes)';
		diffBody = await runGitCommand(['diff', '--color=never'], cwd, { softLimit: GIT_STDOUT_SOFT_LIMIT });
	}
	const untrackedFiles = await runGitCommand(['ls-files', '--others', '--exclude-standard'], cwd);
	const recentCommits = await (async () => {
		try {
			return await runGitCommand(['log', '--oneline', '-5'], cwd);
		} catch (error) {
			const message = toErrorMessage(error);
			if (isHeadMissingError(message)) {
				return 'No commits yet';
			}
			throw error;
		}
	})();

	return [
		formatSection('Git version', gitVersion),
		formatSection('Repository root', repoRoot),
		formatSection('Current branch', branch),
		formatSection('Status (--short --branch)', status),
		formatSection(diffSectionTitle, diffBody),
		formatSection('Untracked files', untrackedFiles),
		formatSection('Recent commits', recentCommits),
	].join('\n\n');
}

function formatSection(title: string, body: string): string {
	const safeBody = truncateForPrompt(body || 'N/A', MAX_SECTION_LENGTH);
	return `### ${title}\n${safeBody}`;
}

function truncateForPrompt(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n... (truncated to ${limit} chars)`;
}

function isHeadMissingError(message: string): boolean {
	return /ambiguous argument 'HEAD'/i.test(message) || /unknown revision/i.test(message) || /does not have any commits yet/i.test(message);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runGitCommand(args: string[], cwd: string, options?: { softLimit?: number }): Promise<string> {
	if (options?.softLimit) {
		return runGitCommandWithSoftLimit(args, cwd, options.softLimit);
	}

	try {
		const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 20 });
		return stdout.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to run git ${args.join(' ')}: ${message}`);
	}
}

async function runGitCommandWithSoftLimit(args: string[], cwd: string, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd });
		let stdout = '';
		let stderr = '';
		let truncated = false;
		let settled = false;

		const finishSuccess = (value: string) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
		};

		const finishFailure = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
		};

		child.stdout.on('data', (chunk: Buffer | string) => {
			if (truncated) {
				return;
			}
			const text = chunk.toString();
			if (stdout.length + text.length > limit) {
				const remaining = Math.max(limit - stdout.length, 0);
				if (remaining > 0) {
					stdout += text.slice(0, remaining);
				}
				truncated = true;
				child.kill('SIGTERM');
				return;
			}
			stdout += text;
		});

		child.stderr.on('data', (chunk: Buffer | string) => {
			if (!truncated) {
				stderr += chunk.toString();
			}
		});

		child.on('error', error => {
			const message = error instanceof Error ? error.message : String(error);
			finishFailure(new Error(`Failed to run git ${args.join(' ')}: ${message}`));
		});

		child.on('close', (code, signal) => {
			if (truncated) {
				finishSuccess(`${stdout.trim()}\n... (truncated to ${limit} chars)`.trim());
				return;
			}
			if (code === 0) {
				finishSuccess(stdout.trim());
				return;
			}
			const signalInfo = signal ? ` signal ${signal}` : '';
			const message = stderr.trim() || `exit code ${code ?? 'unknown'}${signalInfo}`;
			finishFailure(new Error(`Failed to run git ${args.join(' ')}: ${message}`));
		});
	});
}

function buildPrompt(gitContext: string): string {
	const config = vscode.workspace.getConfiguration();
	const japanese = isJapanese();
	const configKey = japanese ? 'commitMessageGeneGemini.prompt.intro.ja' : 'commitMessageGeneGemini.prompt.intro.en';
	const defaultIntro = japanese ? DEFAULT_INTRO_JA : DEFAULT_INTRO_EN;
	const configuredIntro = config.get<string[]>(configKey);
	const resolvedIntro = Array.isArray(configuredIntro)
		? configuredIntro
			.map(line => (typeof line === 'string' ? line.trim() : ''))
			.filter(line => line.length > 0)
		: [];
	const introLines = resolvedIntro.length > 0 ? resolvedIntro : defaultIntro;

	return [...introLines, gitContext].join('\n\n');
}

function isJapanese(): boolean {
	const lang = (vscode.env.language || '').toLowerCase();
	return lang === 'ja' || lang.startsWith('ja-');
}

const DEFAULT_INTRO_EN = [
	'You are an assistant that drafts commit messages using the provided Git information.',
	'All required Git data has already been collected below. Do not run additional git commands.',
	'Follow the Conventional Commits style (type(scope?): subject) for the summary line and add a body only if it helps explain the change. Write the message in English. Do not use Markdown syntax; write in plain text.',
	'Return only the final commit message proposal.',
];

const DEFAULT_INTRO_JA = [
	'あなたは収集されたGit情報でコミットメッセージを作成するアシスタントです。',
	'必要なGitデータはすべて下に用意済みです。追加のgitコマンドは実行しないでください。',
	'サマリー行はConventional Commitsスタイル（type(scope?): subject）に従い、必要な場合のみ本文を追加してください。コミットメッセージは日本語で記述してください。Markdown表記は使わずプレーンなテキストで記述してください。',
	'最終的なコミットメッセージ案だけを返してください。',
];
