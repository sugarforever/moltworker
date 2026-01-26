/**
 * Clawdbot + Cloudflare Sandbox
 *
 * This Worker runs Clawdbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Clawdbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - CLAWDBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import type { Process } from '@cloudflare/sandbox';

export { Sandbox };

const CLAWDBOT_PORT = 18789;
const STARTUP_TIMEOUT_MS = 120_000; // 2 minutes for clawdbot to start (it needs to install deps etc)

interface ClawdbotEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CLAWDBOT_GATEWAY_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
}

/**
 * Build environment variables object from Worker env
 */
function buildEnvVars(env: ClawdbotEnv): Record<string, string> {
  const envVars: Record<string, string> = {};

  if (env.ANTHROPIC_API_KEY) {
    envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  }
  if (env.OPENAI_API_KEY) {
    envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  if (env.CLAWDBOT_GATEWAY_TOKEN) {
    envVars.CLAWDBOT_GATEWAY_TOKEN = env.CLAWDBOT_GATEWAY_TOKEN;
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  }
  if (env.TELEGRAM_DM_POLICY) {
    envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  }
  if (env.DISCORD_BOT_TOKEN) {
    envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  }
  if (env.DISCORD_DM_POLICY) {
    envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  }
  if (env.SLACK_BOT_TOKEN) {
    envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  }
  if (env.SLACK_APP_TOKEN) {
    envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  }

  return envVars;
}

/**
 * Build the clawdbot gateway startup command
 */
function buildStartupCommand(): string {
  return '/usr/local/bin/start-clawdbot.sh';
}

/**
 * Find an existing Clawdbot gateway process
 */
async function findExistingClawdbotProcess(
  sandbox: Sandbox
): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();

    for (const proc of processes) {
      if (
        proc.command.includes('start-clawdbot.sh') ||
        proc.command.includes('clawdbot gateway')
      ) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }

  return null;
}

/**
 * Ensure Clawdbot gateway is running
 * Reuses existing process if one is already running
 */
async function ensureClawdbotGateway(
  sandbox: Sandbox,
  env: ClawdbotEnv
): Promise<Process> {
  // Check if Clawdbot is already running
  const existingProcess = await findExistingClawdbotProcess(sandbox);
  if (existingProcess) {
    console.log('Reusing existing Clawdbot process:', existingProcess.id);

    // Wait for it to be ready if still starting
    if (existingProcess.status === 'starting') {
      console.log('Waiting for existing Clawdbot process to be ready...');
      try {
        // Use TCP mode - Clawdbot gateway uses WebSocket, not HTTP health endpoint
        await existingProcess.waitForPort(CLAWDBOT_PORT, {
          mode: 'tcp',
          timeout: STARTUP_TIMEOUT_MS,
        });
      } catch (e) {
        const logs = await existingProcess.getLogs();
        throw new Error(
          `Clawdbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`
        );
      }
    }

    return existingProcess;
  }

  // Start a new Clawdbot gateway
  console.log('Starting new Clawdbot gateway...');

  const envVars = buildEnvVars(env);
  const command = buildStartupCommand();

  const process = await sandbox.startProcess(command, {
    env: Object.keys(envVars).length > 0 ? envVars : undefined,
  });

  // Wait for the gateway to be ready
  try {
    console.log('Waiting for Clawdbot gateway to be ready on port', CLAWDBOT_PORT);
    // Use TCP mode - Clawdbot gateway uses WebSocket, not HTTP health endpoint
    await process.waitForPort(CLAWDBOT_PORT, {
      mode: 'tcp',
      timeout: STARTUP_TIMEOUT_MS,
    });
    console.log('Clawdbot gateway is ready!');
  } catch (e) {
    const logs = await process.getLogs();
    console.error('Clawdbot startup failed. Stderr:', logs.stderr);
    console.error('Clawdbot startup failed. Stdout:', logs.stdout);
    throw new Error(
      `Clawdbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`
    );
  }

  return process;
}

/**
 * Proxy a request to the Clawdbot gateway
 */
async function proxyToClawdbot(
  request: Request,
  sandbox: Sandbox
): Promise<Response> {
  // Use containerFetch which handles both HTTP and WebSocket
  return sandbox.containerFetch(request, CLAWDBOT_PORT);
}

export default {
  async fetch(request: Request, env: ClawdbotEnv): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'clawdbot');

    // Health check endpoint (before starting clawdbot)
    if (url.pathname === '/sandbox-health') {
      return Response.json({
        status: 'ok',
        service: 'clawdbot-sandbox',
        gateway_port: CLAWDBOT_PORT,
      });
    }

    // Ensure Clawdbot is running
    try {
      await ensureClawdbotGateway(sandbox, env);
    } catch (error) {
      console.error('Failed to start Clawdbot:', error);
      return new Response(
        JSON.stringify({
          error: 'Clawdbot gateway failed to start',
          details: error instanceof Error ? error.message : 'Unknown error',
          hint: 'Check that ANTHROPIC_API_KEY is set via wrangler secrets',
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Proxy all requests to Clawdbot
    return proxyToClawdbot(request, sandbox);
  },
};
