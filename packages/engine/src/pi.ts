/**
 * Shared pi SDK setup for kb engine agents.
 *
 * Uses the user's existing pi auth (API keys / OAuth from ~/.pi/agent/auth.json).
 * Provides factory functions for creating triage and executor agent sessions.
 */

import { EventEmitter } from "node:events";
import * as undici from "undici";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface AgentResult {
  session: AgentSession;
}

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let httpDispatcherConfigured = false;
const ignoreUndiciDispatcherError = (_error: Error): void => {};

function withUndiciErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options & { connections?: number };
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(new undici.Pool(origin, {
    ...dispatcherOptions,
    factory: createUndiciClient,
  }));
}

/**
 * Match the pi CLI's Node startup behavior for SDK consumers. Node fetch does
 * not honor HTTP(S)_PROXY by itself, so install undici's environment-aware,
 * crash-safe dispatcher before ModelRuntime performs network operations.
 */
export function configurePiSdkHttp(): void {
  if (httpDispatcherConfigured) return;

  const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: 300_000,
    connect: { autoSelectFamilyAttemptTimeout: 2_000 },
    headersTimeout: 300_000,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch and the dispatcher on the same undici implementation without
  // overwriting a deliberate fetch replacement installed by the host app.
  const shouldInstallGlobals = installedGlobalFetch === undefined
    ? globalThis.fetch === originalGlobalFetch
    : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }

  httpDispatcherConfigured = true;
}

export function getAgentToolNames(
  permission: AgentOptions["tools"],
  customTools: ToolDefinition[] = [],
): string[] {
  const builtInTools = permission === "readonly"
    ? ["read", "grep", "find", "ls"]
    : ["read", "bash", "edit", "write"];
  return [...builtInTools, ...customTools.map((tool) => tool.name)];
}

export interface AgentOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  customTools?: ToolDefinition[];
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
  /** Default model provider (e.g. "anthropic"). Used with `defaultModelId` to select a specific model. */
  defaultProvider?: string;
  /** Default model ID within the provider (e.g. "claude-sonnet-4-5"). Used with `defaultProvider`. */
  defaultModelId?: string;
  /** Default thinking effort level (e.g. "medium", "high"). When provided, sets the session's thinking level after creation. */
  defaultThinkingLevel?: string;
}

/**
 * Create a pi agent session configured for kb.
 * Reuses the user's existing pi auth and model configuration.
 */
export async function createKbAgent(options: AgentOptions): Promise<AgentResult> {
  configurePiSdkHttp();
  const modelRuntime = await ModelRuntime.create();

  // An explicit pi 0.84 tool allowlist applies to custom tools too, so include
  // their names or task/reporting tools such as review_spec will be disabled.
  const tools = getAgentToolNames(options.tools, options.customTools);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  // Built-in tools format output through the shared theme proxy. The pi CLI
  // initializes it during startup, but SDK consumers must do so explicitly.
  initTheme(settingsManager.getTheme(), false);

  // Resolve explicit model selection if provider and model ID are specified
  const selectedModel = options.defaultProvider && options.defaultModelId
    ? modelRuntime.getModel(options.defaultProvider, options.defaultModelId)
    : undefined;

  if (options.defaultProvider && options.defaultModelId && !selectedModel) {
    throw new Error(
      `Model not found: ${options.defaultProvider}/${options.defaultModelId}. ` +
        "Run 'pi --list-models' to see available models.",
    );
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalExtensionPaths: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime,
    resourceLoader,
    tools,
    customTools: options.customTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    ...(selectedModel ? { model: selectedModel } : {}),
  });

  // Apply thinking level if specified
  if (options.defaultThinkingLevel) {
    session.setThinkingLevel(options.defaultThinkingLevel as any);
  }

  // Wire up event listeners
  session.subscribe((event) => {
    if (event.type === "message_update") {
      const msgEvent = event.assistantMessageEvent;
      if (msgEvent.type === "text_delta") {
        options.onText?.(msgEvent.delta);
      } else if (msgEvent.type === "thinking_delta") {
        options.onThinking?.(msgEvent.delta);
      }
    }
    if (event.type === "tool_execution_start") {
      options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
    }
    if (event.type === "tool_execution_end") {
      options.onToolEnd?.(event.toolName, event.isError, event.result);
    }
  });

  return { session };
}
