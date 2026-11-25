import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { NIHO_EDIT_COMMAND_USAGE } from "./niho-edit-usage.mjs";

const CLI_PATH = fileURLToPath(new URL("./niho-edit.mjs", import.meta.url));
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_INPUT_SCHEMA = z.object({
  args: z.array(z.string().max(4096)).max(256).optional(),
  stdin: z.string().optional()
});

function runCli(command, args, stdin, { origin, siteId }) {
  if (args.some((arg) => arg === "--origin" || arg === "--site"
    || arg.startsWith("--origin=") || arg.startsWith("--site=") || arg.includes("\u0000"))) {
    return Promise.resolve({ exitCode: 1, stdout: "{\"error\":\"invalid_arguments\"}\n" });
  }
  if (stdin !== undefined && Buffer.byteLength(stdin, "utf8") > MAX_INPUT_BYTES) {
    return Promise.resolve({ exitCode: 1, stdout: "{\"error\":\"input_too_large\"}\n" });
  }

  const cliArgs = command === "cms-diff"
    ? [CLI_PATH, command, ...args]
    : [CLI_PATH, "--origin", origin, "--site", siteId, command, ...args];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cliArgs, { shell: false, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdinFailed = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TOOL_TIMEOUT_MS);
    timeout.unref();

    const appendOutput = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", appendOutput);
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.stdin.once("error", (error) => {
      if (error.code === "EPIPE") return;
      stdinFailed = true;
      child.kill("SIGTERM");
    });
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, stdout: "{\"error\":\"cli_unavailable\"}\n" });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve({ exitCode: 1, stdout: "{\"error\":\"cli_timeout\"}\n" });
      } else if (outputLimitExceeded) {
        resolve({ exitCode: 1, stdout: "{\"error\":\"output_too_large\"}\n" });
      } else if (stdinFailed) {
        resolve({ exitCode: 1, stdout: "{\"error\":\"cli_stdin_failed\"}\n" });
      } else {
        resolve({ exitCode: exitCode ?? 1, stdout: stdout || (exitCode === 0 ? "" : `${stderr.trim() || "niho-edit command failed"}\n`) });
      }
    });
    child.stdin.end(stdin ?? "");
  });
}

export function startMcpServer(config) {
  serveStdio(() => {
    const server = new McpServer({ name: "niho-edit", version: "0.1.0" });
    for (const [command, usage] of Object.entries(NIHO_EDIT_COMMAND_USAGE)) {
      server.registerTool(command, {
        title: `niho-edit ${command}`,
        description: `CLI command: ${usage}\nPass tokens after the command in args. For file arguments written as -, pass the input text in stdin. The configured origin and site are fixed. Studio-native CMS commands require --studio in args and a Studio origin.`,
        inputSchema: TOOL_INPUT_SCHEMA
      }, async ({ args = [], stdin }) => {
        const result = await runCli(command, args, stdin, config);
        return {
          content: [{ type: "text", text: result.stdout }],
          ...(result.exitCode === 0 ? {} : { isError: true })
        };
      });
    }
    return server;
  }, {
    onerror(error) {
      process.stderr.write(`niho-edit MCP: ${error.message}\n`);
    }
  });
}
