import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REQUEST_TIMEOUT_MS,
  isEntrypoint,
  runManualUnread,
} from "../shared/hooks/manual-unread.mjs";

const sessionReminderPath = fileURLToPath(
  new URL("../shared/hooks/session-reminder.mjs", import.meta.url),
);
const manualUnreadPath = fileURLToPath(
  new URL("../shared/hooks/manual-unread.mjs", import.meta.url),
);

function runNode(path, environment = {}, nodeArguments = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArguments, path], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function withCaptureServer(respond, run) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authHeader: request.headers.authorization,
      agentClient: request.headers["x-agent-client"],
    });
    respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function captureOutput() {
  const output = [];
  return { output, write: (value) => output.push(value) };
}

async function withFetchPreload(run) {
  const root = await mkdtemp(join(tmpdir(), "parley-plugin-hook-entry-"));
  const capturePath = join(root, "capture.json");
  const preloadPath = join(root, "fetch-preload.mjs");
  await writeFile(
    preloadPath,
    [
      'import { writeFile } from "node:fs/promises";',
      `const capturePath = ${JSON.stringify(capturePath)};`,
      "globalThis.fetch = async (url, options) => {",
      "  await writeFile(capturePath, JSON.stringify({",
      "    url: String(url),",
      "    method: options.method,",
      "    authenticated: options.headers.Authorization === `Bearer ${process.env.PARLEY_TOKEN}` ,",
      "    agentClient: options.headers['X-Agent-Client'],",
      "  }));",
      '  return new Response(JSON.stringify({ total: 1 }), { status: 200 });',
      "};",
      "",
    ].join("\n"),
  );
  try {
    await run({ capturePath, preloadUrl: pathToFileURL(preloadPath).href });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("OAuth session reminder emits one line and makes no request", async () => {
  await withCaptureServer(
    (_request, response) => response.end("unexpected"),
    async ({ baseUrl, requests }) => {
      const result = await runNode(sessionReminderPath, { PARLEY_BASE_URL: baseUrl });
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(
        result.stdout,
        "Parley is connected. Check the Parley inbox before starting work.\n",
      );
      assert.equal(result.stderr, "");
      assert.deepEqual(requests, []);
    },
  );
});

test("manual unread stays quiet without a credential or with conflicting credentials", async () => {
  await withCaptureServer(
    (_request, response) => response.end(JSON.stringify({ total: 4 })),
    async ({ baseUrl, requests }) => {
      for (const environment of [
        {},
        { PARLEY_TOKEN: "first-token", CLAUDE_PLUGIN_OPTION_PARLEY_TOKEN: "second-token" },
      ]) {
        const capture = captureOutput();
        await runManualUnread({ environment, baseUrl, write: capture.write });
        assert.deepEqual(capture.output, []);
      }
      assert.deepEqual(requests, []);
    },
  );
});

test("manual unread sends one authorized request and emits only the count", async () => {
  await withCaptureServer(
    (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ total: 4, ignored: "not-for-output" }));
    },
    async ({ baseUrl, requests }) => {
      const token = "manual-test-token";
      const capture = captureOutput();
      await runManualUnread({
        environment: { PARLEY_TOKEN: token },
        baseUrl,
        write: capture.write,
      });

      assert.deepEqual(requests, [
        {
          method: "GET",
          url: "/unread?format=json",
          authHeader: `Bearer ${token}`,
          agentClient: "manual",
        },
      ]);
      assert.deepEqual(capture.output, ["Parley: 4 unread message(s).\n"]);
      assert.doesNotMatch(capture.output.join(""), new RegExp(token));
      assert.doesNotMatch(capture.output.join(""), /not-for-output/);
    },
  );
});

test("manual unread stays quiet for zero unread and invalid responses", async (context) => {
  const cases = [
    { name: "zero", status: 200, body: JSON.stringify({ total: 0 }) },
    { name: "non-success", status: 503, body: JSON.stringify({ total: 9 }) },
    { name: "malformed JSON", status: 200, body: "not json" },
    { name: "oversized body", status: 200, body: "x".repeat(16 * 1024 + 1) },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      await withCaptureServer(
        (_request, response) => {
          response.statusCode = item.status;
          response.end(item.body);
        },
        async ({ baseUrl, requests }) => {
          const capture = captureOutput();
          await runManualUnread({
            environment: { CLAUDE_PLUGIN_OPTION_PARLEY_TOKEN: "claude-test-token" },
            baseUrl,
            write: capture.write,
          });
          assert.deepEqual(capture.output, []);
          assert.equal(requests.length, 1);
        },
      );
    });
  }
});

test("manual unread uses a three-second production timeout and fails open on timeout", async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 3_000);
  await withCaptureServer(
    () => {},
    async ({ baseUrl, requests }) => {
      const capture = captureOutput();
      await runManualUnread({
        environment: { PARLEY_TOKEN: "timeout-test-token" },
        baseUrl,
        timeoutMs: 20,
        write: capture.write,
      });
      assert.deepEqual(capture.output, []);
      assert.equal(requests.length, 1);
    },
  );
});

test("manual unread recognizes a resolved Windows script path", { skip: process.platform !== "win32" }, () => {
  assert.equal(
    isEntrypoint(
      "C:\\workspace\\shared\\hooks\\manual-unread.mjs",
      "file:///C:/workspace/shared/hooks/manual-unread.mjs",
    ),
    true,
  );
});

test("manual unread entrypoint executes once with a captured fetch", async () => {
  const token = "spawn-test-token";
  await withFetchPreload(async ({ capturePath, preloadUrl }) => {
    const result = await runNode(manualUnreadPath, { PARLEY_TOKEN: token }, ["--import", preloadUrl]);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "Parley: 1 unread message(s).\n");
    assert.equal(result.stderr, "");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
    assert.deepEqual(capture, {
      url: "https://parley.weldra.dev/unread?format=json",
      method: "GET",
      authenticated: true,
      agentClient: "manual",
    });
  });
});
